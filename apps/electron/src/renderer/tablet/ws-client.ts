/**
 * Tablet WS Client — 平板端与主进程 remote-service 的通信层
 *
 * 职责：
 *  - 管理 WebSocket 连接（含 token 鉴权、自动重连、心跳）
 *  - 发送指令（list_sessions / list_channels / send_message / create_session /
 *    session_detail / stop_agent / ping，以及 Chat 工具全套指令）
 *  - 分发事件（hello / agent_event / chat_event / command_result）
 *
 * 所有 Agent 工作流事件通过 agent_event 推送，Chat 流式事件通过 chat_event 推送，
 * 这里统一交给对应订阅者处理。
 */

export type AgentWorkflowEvent = {
  sessionId: string
  payload: unknown
}

export type ChatWorkflowEvent = {
  conversationId: string
  /** 桌面 CHAT_IPC_CHANNELS 同名通道（chat:stream:chunk 等） */
  channel: string
  payload: unknown
}

type CommandResultMessage = {
  kind: 'command_result'
  requestId: string | null
  ok: boolean
  data?: unknown
  error?: string
}

type InboundMessage =
  | { kind: 'hello'; serverTime: number }
  | { kind: 'pong'; serverTime: number }
  | { kind: 'agent_event'; sessionId: string; payload: unknown }
  | { kind: 'chat_event'; conversationId: string; channel: string; payload: unknown }
  | CommandResultMessage

export interface WsClientOptions {
  /** 连接地址，如 ws://192.168.1.10:7788/ws */
  url: string
  /** 访问令牌 */
  token: string
  /** 连接状态变化回调 */
  onStatusChange?: (status: 'connecting' | 'open' | 'closed' | 'error' | 'unauthorized', info?: string) => void
  /** Agent 工作流事件回调 */
  onAgentEvent?: (evt: AgentWorkflowEvent) => void
  /** Chat 流式事件回调 */
  onChatEvent?: (evt: ChatWorkflowEvent) => void
  /** 指令结果回调（按 requestId 分发） */
  onCommandResult?: (result: CommandResultMessage) => void
}

export class WsClient {
  private url: string
  private token: string
  private ws: WebSocket | null = null
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pendingCommands = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

  /** 待发消息队列：连接断开时暂存 send_message，重连后按序重放（幂等去重依靠 clientMessageId）。
   *  只暂存「用户核心输入」类操作；stop/权限/读操作时效性强，断线后应重新发起而非重放。 */
  private outgoingQueue: Array<{
    payload: Record<string, unknown>
    clientMessageId: string
    resolve: (r: unknown) => void
    reject: (e: Error) => void
  }> = []
  /** 重连后是否正在 flush 队列（防止 open 事件与显式 flush 并发重复）。 */
  private flushingQueue = false
  /** 最近一次收到服务端 pong（或任何入站帧）的时间戳，用于假死检测。 */
  private lastPongAt = 0

  onStatusChange?: WsClientOptions['onStatusChange']
  onAgentEvent?: WsClientOptions['onAgentEvent']
  onChatEvent?: WsClientOptions['onChatEvent']
  onCommandResult?: WsClientOptions['onCommandResult']

  constructor(options: WsClientOptions) {
    this.url = options.url
    this.token = options.token
    this.onStatusChange = options.onStatusChange
    this.onAgentEvent = options.onAgentEvent
    this.onChatEvent = options.onChatEvent
    this.onCommandResult = options.onCommandResult
  }

  connect(): void {
    this.shouldReconnect = true
    this.openSocket()
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  private openSocket(): void {
    this.emitStatus('connecting')
    try {
      // token 通过 query 传递，服务端 /ws 鉴权读取
      const separator = this.url.includes('?') ? '&' : '?'
      const wsUrl = `${this.url}${separator}token=${encodeURIComponent(this.token)}`
      this.ws = new WebSocket(wsUrl)
    } catch (e) {
      this.emitStatus('error', String(e))
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.clearHeartbeat()
      this.lastPongAt = Date.now()
      // 心跳保持连接：既定期发 ping，也检测假死（发送 ping 但长时间无 pong/任何入站帧）。
      this.heartbeatTimer = setInterval(() => {
        try {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }))
          }
        } catch {
          /* ignore */
        }
        // 假死检测：超过阈值仍未收到任何入站帧（含 pong），判定半开/假死连接，主动断开触发重连。
        if (Date.now() - this.lastPongAt > HEARTBEAT_DEAD_THRESHOLD_MS) {
          try { this.ws?.close() } catch { /* ignore */ }
        }
      }, 25000)
      this.emitStatus('open')
      // 重连成功后重放断线期间积压的待发消息（send_message），保证弱网下用户输入不丢。
      this.flushOutgoingQueue()
    }

    this.ws.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        const msg = JSON.parse(raw) as InboundMessage
        // 任何入站帧都视为存活信号，刷新假死检测计时（服务端闲置踢人同样用入站活跃度）。
        this.lastPongAt = Date.now()
        this.handleMessage(msg)
      } catch (e) {
        console.error('[Tablet WS] 消息解析失败', e)
      }
    }

    this.ws.onclose = (event) => {
      this.clearHeartbeat()
      this.rejectAllPending(new Error('连接已关闭'))
      // 服务端鉴权失败：remote-service 对无效 token 的处理是「先握手成功，再 close(4001)」
      // （见 main/lib/remote-service.ts 的 wss.on('connection'））。若此时仍走自动重连，
      // 会形成「连接成功 → 被踢 → 2 秒重连」死循环，表现为登录页/主界面频繁闪动。
      // 因此收到 4001 时停止重连，由 UI 提示用户重新输入 token 后手动重连。
      if (event.code === 4001) {
        this.emitStatus('unauthorized', event.reason || 'unauthorized')
        return
      }
      this.emitStatus('closed')
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.emitStatus('error')
    }
  }

  private handleMessage(msg: InboundMessage): void {
    switch (msg.kind) {
      case 'hello':
        // 连接就绪
        break
      case 'pong':
        // 存活信号已在 onmessage 统一刷新 lastPongAt，这里无需额外处理。
        break
      case 'agent_event':
        this.onAgentEvent?.({
          sessionId: msg.sessionId,
          payload: msg.payload,
        })
        break
      case 'chat_event':
        this.onChatEvent?.({
          conversationId: msg.conversationId,
          channel: msg.channel,
          payload: msg.payload,
        })
        break
      case 'command_result':
        this.resolveCommandResult(msg)
        this.onCommandResult?.(msg)
        break
    }
  }

  private resolveCommandResult(msg: CommandResultMessage): void {
    const id = msg.requestId as string | undefined
    if (id && this.pendingCommands.has(id)) {
      const pending = this.pendingCommands.get(id)!
      this.pendingCommands.delete(id)
      if (msg.ok) pending.resolve(msg.data)
      else pending.reject(new Error(msg.error || '指令失败'))
      return
    }
    // 无 requestId 时用 FIFO 兜底（兼容）
    const fallback = this.pendingCommands.entries().next().value as [string, { resolve: (r: unknown) => void; reject: (e: Error) => void }] | undefined
    if (fallback) {
      const [fid, pending] = fallback
      this.pendingCommands.delete(fid)
      if (msg.ok) pending.resolve(msg.data)
      else pending.reject(new Error(msg.error || '指令失败'))
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pendingCommands) {
      p.reject(err)
    }
    this.pendingCommands.clear()
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return
    if (this.reconnectTimer) return
    // 页面在后台时不调度定时器：Android 后台 WebView 的 JS 定时器会被节流/冻结，
    // 空转重连无意义；恢复前台时由 reconnectNow() 立即触发，避免“切回时还在等定时器”。
    if (typeof document !== 'undefined' && document.hidden) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect) this.openSocket()
    }, 2000)
  }

  /**
   * 立即重连（页面恢复前台时调用）。
   * - 连接仍 OPEN / 正在 CONNECTING：no-op（无感，不打断现有会话）
   * - 已断开且允许重连：立即发起，不等 2s 定时器
   */
  reconnectNow(): void {
    if (!this.shouldReconnect) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const rs = this.ws?.readyState
    if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return
    this.openSocket()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private emitStatus(status: 'connecting' | 'open' | 'closed' | 'error' | 'unauthorized', info?: string): void {
    this.onStatusChange?.(status, info)
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * 发送一条指令并等待 command_result。
   * 若连接未就绪则立即 reject。
   */
  sendCommand<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('连接未就绪，请稍候重试'))
    }
    return new Promise<T>((resolve, reject) => {
      // 追踪 ID 用独立字段 _cmdId，绝不覆盖业务 payload 里的 requestId
      // （respond_ask_user / respond_permission / respond_exit_plan_mode 的业务 requestId 是 UUID，
      //  与命令追踪 ID 重名冲突曾被展开覆盖，导致主进程收到命令 ID 去查 pending → “提问请求不存在”）。
      const cmdId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      this.pendingCommands.set(cmdId, { resolve: resolve as (r: unknown) => void, reject })
      this.ws!.send(JSON.stringify({ ...payload, _cmdId: cmdId }))
      // 超时兜底
      setTimeout(() => {
        if (this.pendingCommands.has(cmdId)) {
          this.pendingCommands.delete(cmdId)
          reject(new Error('指令超时'))
        }
      }, 15000)
    })
  }

  // ===== 便捷方法 =====

  ping(): Promise<unknown> {
    return this.sendCommand({ type: 'ping' })
  }

  listSessions(): Promise<unknown> {
    return this.sendCommand({ type: 'list_sessions' })
  }

  listWorkspaces(): Promise<unknown> {
    return this.sendCommand({ type: 'list_workspaces' })
  }

  createWorkspace(name: string): Promise<unknown> {
    return this.sendCommand({ type: 'create_workspace', name })
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'delete_session', sessionId })
  }

  /** 分叉会话（从指定消息处创建新会话继续；对齐桌面 forkAgentSession） */
  forkSession(payload: { sessionId: string; upToMessageUuid?: string }): Promise<unknown> {
    return this.sendCommand({ type: 'fork_session', ...payload })
  }

  /** 快照回退（同一会话内回退到指定点，恢复文件 + 截断对话；对齐桌面 rewindSession） */
  rewindSession(payload: { sessionId: string; assistantMessageUuid: string }): Promise<unknown> {
    return this.sendCommand({ type: 'rewind_session', ...payload })
  }

  /** 置顶/取消置顶（对齐桌面 togglePinAgentSession） */
  toggleSessionPin(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'toggle_session_pin', sessionId })
  }

  /** 归档/取消归档（对齐桌面 toggleArchiveAgentSession） */
  toggleSessionArchive(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'toggle_session_archive', sessionId })
  }

  /** 移动会话到项目（对齐桌面 moveAgentSessionToWorkspace） */
  moveSessionToWorkspace(payload: { sessionId: string; targetWorkspaceId: string }): Promise<unknown> {
    return this.sendCommand({ type: 'move_session_to_workspace', ...payload })
  }

  /** 设置会话推理档位（对齐桌面 updateSessionOpenAIThinkingLevel） */
  updateSessionThinkingLevel(sessionId: string, level: string | null): Promise<unknown> {
    return this.sendCommand({ type: 'update_session_thinking_level', sessionId, level })
  }

  getUserProfile(): Promise<unknown> {
    return this.sendCommand({ type: 'get_user_profile' })
  }

  listChannels(): Promise<unknown> {
    return this.sendCommand({ type: 'list_channels' })
  }

  sessionDetail(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'session_detail', sessionId })
  }

  getSdkMessages(
    sessionId: string,
    opts?: { before?: number; targetMessages?: number },
  ): Promise<unknown> {
    return this.sendCommand({
      type: 'get_sdk_messages',
      sessionId,
      ...(opts ?? {}),
    })
  }

  getPendingInteractions(sessionId?: string): Promise<unknown> {
    return this.sendCommand({ type: 'get_pending_interactions', sessionId })
  }

  respondPermission(requestId: string, behavior: 'allow' | 'deny', alwaysAllow = false): Promise<unknown> {
    return this.sendCommand({ type: 'respond_permission', requestId, behavior, alwaysAllow })
  }

  respondAskUser(requestId: string, answers: Record<string, string>): Promise<unknown> {
    return this.sendCommand({ type: 'respond_ask_user', requestId, answers })
  }

  respondExitPlanMode(requestId: string, action: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback', feedback?: string): Promise<unknown> {
    return this.sendCommand({ type: 'respond_exit_plan_mode', requestId, action, feedback })
  }

  updateSessionModel(sessionId: string, channelId: string, modelId?: string): Promise<unknown> {
    return this.sendCommand({ type: 'update_session_model', sessionId, channelId, modelId })
  }

  updateSessionRuntime(sessionId: string, runtime: 'claude' | 'pi'): Promise<unknown> {
    return this.sendCommand({ type: 'update_session_runtime', sessionId, runtime })
  }

  updatePermissionMode(sessionId: string, mode: 'auto' | 'plan' | 'bypassPermissions'): Promise<unknown> {
    return this.sendCommand({ type: 'update_permission_mode', sessionId, mode })
  }

  uploadAttachment(sessionId: string, filename: string, base64: string): Promise<{ filename: string; path: string; size: number }> {
    return this.sendCommand({ type: 'upload_attachment', sessionId, filename, base64 })
  }

  renameSession(sessionId: string, title: string): Promise<unknown> {
    return this.sendCommand({ type: 'rename_session', sessionId, title })
  }

  createSession(payload: { title?: string; channelId?: string; workspaceId?: string; modelId?: string }): Promise<unknown> {
    return this.sendCommand({ type: 'create_session', ...payload })
  }

  /** 项目草稿会话复用语义（对齐桌面 ensureProjectDraftAgentSession）：已有则复用，没有才创建 */
  ensureProjectDraftSession(payload: { workspaceId: string; channelId?: string; modelId?: string }): Promise<unknown> {
    return this.sendCommand({ type: 'ensure_project_draft_session', ...payload })
  }

  sendMessage(payload: { sessionId: string; userMessage: string; channelId: string; modelId?: string; workspaceId?: string }): Promise<unknown> {
    // 幂等去重键：每次发送同一逻辑消息共享同一 clientMessageId，重连重放时服务端据此去重。
    const clientMessageId = WsClient.newClientMessageId()
    const frame = { type: 'send_message', ...payload, clientMessageId }
    return this.queueMessageOrSend(frame)
  }

  /**
   * 生成客户端消息幂等键。浏览器环境用 Web Crypto 的 randomUUID，
   * 不可用（极老 WebView）时回退 Date.now + 随机串；碰撞概率对本场景足够低。
   */
  private static newClientMessageId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
  }

  /**
   * 发送 send_message：连接就绪则直接发；断线则入队等待重连后重放。
   * 返回的 Promise 会一直 pending 到「服务端确认 accepted」或「确认不可达（如业务拒绝）」才 settle。
   */
  private queueMessageOrSend(frame: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.isOpen()) {
        this.transmitOutgoing(frame, resolve, reject)
        return
      }
      // 断线：入队，重连后 flush 时按序重放（保持 clientMessageId 不变，服务端幂等）。
      this.outgoingQueue.push({ payload: frame, clientMessageId: String(frame.clientMessageId), resolve, reject })
    })
  }

  /** 实际把一条 send_message 帧发上 WS，并绑定完成回调和失败处理。 */
  private transmitOutgoing(
    frame: Record<string, unknown>,
    resolve: (r: unknown) => void,
    reject: (e: Error) => void,
  ): void {
    const clientMessageId = String(frame.clientMessageId ?? '')
    // 走 sendCommand 的内部追踪；服务端收到即回 command_result（send_message 是 fire-and-forget，
    // 立即返回 accepted，不等待 run 结束）。成功即从「待确认」中移除。
    this.sendCommand(frame).then(
      (r) => {
        resolve(r)
      },
      (err: Error) => {
        // 连接类失败（未就绪/已关闭/超时）意味着消息可能未送达，重新入队等待重放；
        // 业务类拒绝（如「会话正在处理中」）则直接 reject，不重试（重复尝试也无效）。
        if (isTransientConnectionError(err)) {
          this.outgoingQueue.push({ payload: frame, clientMessageId, resolve, reject })
        } else {
          reject(err)
        }
      },
    )
  }

  /** 重连成功后按序重放积压消息。WS 的 send 是同步入队、顺序保证的，
   *  同一同步循环内逐个 transmitOutgoing 即保持到达顺序，无需 async 串行等待。 */
  private flushOutgoingQueue(): void {
    if (this.flushingQueue) return
    const items = this.outgoingQueue.splice(0, this.outgoingQueue.length)
    if (items.length === 0) return
    this.flushingQueue = true
    for (const item of items) {
      if (!this.isOpen()) {
        // flush 过程中又断开：未发出的放回队列（保持顺序），等待下次重连。
        this.outgoingQueue.unshift(item)
        continue
      }
      this.transmitOutgoing(item.payload, item.resolve, item.reject)
    }
    this.flushingQueue = false
  }

  /**
   * 向正在运行的 Agent 注入消息（流式追加 / 软打断）
   *
   * 对齐桌面 queueAgentMessage IPC：interrupt=true 时先软打断当前 turn 再立即注入，
   * false/缺省时排队追加（当前 turn 结束后消费）；uuid 用于幂等去重。
   * 会话未运行时主进程会拒绝（"会话未运行"），调用方应降级为 sendMessage 新建 run。
   */
  queueMessage(payload: {
    sessionId: string
    userMessage: string
    rawUserMessage?: string
    uuid?: string
    interrupt?: boolean
    mentionedSkills?: string[]
    mentionedMcpServers?: string[]
    mentionedSessionIds?: string[]
  }): Promise<unknown> {
    return this.sendCommand({ type: 'queue_message', ...payload })
  }

  stopAgent(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'stop_agent', sessionId })
  }

  // ===== Chat（聊天工具）指令 =====

  listConversations(): Promise<unknown> {
    return this.sendCommand({ type: 'list_conversations' })
  }

  createConversation(payload: { title?: string; modelId?: string; channelId?: string }): Promise<unknown> {
    return this.sendCommand({ type: 'create_conversation', ...payload })
  }

  getConversationMessages(conversationId: string): Promise<unknown> {
    return this.sendCommand({ type: 'get_conversation_messages', conversationId })
  }

  getRecentMessages(conversationId: string, limit: number): Promise<unknown> {
    return this.sendCommand({ type: 'get_recent_messages', conversationId, limit })
  }

  updateConversationTitle(conversationId: string, title: string): Promise<unknown> {
    return this.sendCommand({ type: 'update_conversation_title', conversationId, title })
  }

  updateConversationModel(conversationId: string, modelId?: string, channelId?: string): Promise<unknown> {
    return this.sendCommand({ type: 'update_conversation_model', conversationId, modelId, channelId })
  }

  deleteConversation(conversationId: string): Promise<unknown> {
    return this.sendCommand({ type: 'delete_conversation', conversationId })
  }

  toggleConversationPin(conversationId: string): Promise<unknown> {
    return this.sendCommand({ type: 'toggle_conversation_pin', conversationId })
  }

  toggleConversationArchive(conversationId: string): Promise<unknown> {
    return this.sendCommand({ type: 'toggle_conversation_archive', conversationId })
  }

  searchChatMessages(query: string): Promise<unknown> {
    return this.sendCommand({ type: 'search_chat_messages', query })
  }

  searchAgentSessionMessages(query: string): Promise<unknown> {
    return this.sendCommand({ type: 'search_agent_session_messages', query })
  }

  chatSendMessage(payload: {
    conversationId: string
    userMessage: string
    channelId: string
    modelId?: string
    contextLength?: number
    contextDividers?: string[]
    attachments?: unknown[]
    knowledgeReferences?: unknown[]
    thinkingEnabled?: boolean
    systemMessage?: string
    enabledToolIds?: string[]
  }): Promise<unknown> {
    return this.sendCommand({ type: 'chat_send_message', ...payload })
  }

  chatStopGeneration(conversationId: string): Promise<unknown> {
    return this.sendCommand({ type: 'chat_stop_generation', conversationId })
  }

  chatDeleteMessage(conversationId: string, messageId: string): Promise<unknown> {
    return this.sendCommand({ type: 'chat_delete_message', conversationId, messageId })
  }

  chatTruncateMessagesFrom(conversationId: string, messageId: string, preserveFirstMessageAttachments?: boolean): Promise<unknown> {
    return this.sendCommand({ type: 'chat_truncate_messages_from', conversationId, messageId, preserveFirstMessageAttachments })
  }

  chatUpdateContextDividers(conversationId: string, dividers: string[]): Promise<unknown> {
    return this.sendCommand({ type: 'chat_update_context_dividers', conversationId, dividers })
  }

  chatGenerateTitle(input: { userMessage: string; channelId: string; modelId?: string }): Promise<unknown> {
    return this.sendCommand({ type: 'chat_generate_title', ...input })
  }

  chatSaveAttachment(input: { conversationId: string; filename: string; mediaType: string; data: string }): Promise<unknown> {
    return this.sendCommand({ type: 'chat_save_attachment', ...input })
  }

  chatDeleteAttachment(localPath: string): Promise<unknown> {
    return this.sendCommand({ type: 'chat_delete_attachment', localPath })
  }

  chatReadAttachment(localPath: string): Promise<unknown> {
    return this.sendCommand({ type: 'chat_read_attachment', localPath })
  }
}

/** 派生默认 WS 地址（与当前 HTTP 页面同源，补 /ws） */
export function defaultWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

/**
 * 判断 send_message 失败是否为「连接类（瞬时）」错误 —— 此类错误下消息可能未送达，
 * 应当重新入队等待重连后重放；而不是像业务拒绝那样直接丢弃。
 * 连接未就绪 / 连接已关闭 / 指令超时 都视为瞬时；其余（主进程返回的业务错误）不可重试。
 */
function isTransientConnectionError(err: Error): boolean {
  const msg = err?.message ?? ''
  return (
    msg === '连接未就绪，请稍候重试' ||
    msg === '连接已关闭' ||
    msg === '指令超时'
  )
}

/**
 * 假死检测阈值：超过此毫秒数未收到任何入站帧（含 pong）判定为半开/假死连接，主动断开重连。
 * 心跳周期 25s，阈值取 3 个周期（75s），容忍偶发丢包与单次 ping 丢失。
 */
const HEARTBEAT_DEAD_THRESHOLD_MS = 3 * 25000
