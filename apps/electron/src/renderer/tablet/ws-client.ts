/**
 * Tablet WS Client — 平板端与主进程 remote-service 的通信层
 *
 * 职责：
 *  - 管理 WebSocket 连接（含 token 鉴权、自动重连、心跳）
 *  - 发送指令（list_sessions / list_channels / send_message / create_session /
 *    session_detail / stop_agent / ping）
 *  - 分发事件（hello / agent_event / command_result）
 *
 * 所有 Agent 工作流事件通过 agent_event 推送，这里统一交给订阅者处理。
 */

export type AgentWorkflowEvent = {
  sessionId: string
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
  | { kind: 'agent_event'; sessionId: string; payload: unknown }
  | CommandResultMessage

export interface WsClientOptions {
  /** 连接地址，如 ws://192.168.1.10:7788/ws */
  url: string
  /** 访问令牌 */
  token: string
  /** 连接状态变化回调 */
  onStatusChange?: (status: 'connecting' | 'open' | 'closed' | 'error', info?: string) => void
  /** Agent 工作流事件回调 */
  onAgentEvent?: (evt: AgentWorkflowEvent) => void
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

  onStatusChange?: WsClientOptions['onStatusChange']
  onAgentEvent?: WsClientOptions['onAgentEvent']
  onCommandResult?: WsClientOptions['onCommandResult']

  constructor(options: WsClientOptions) {
    this.url = options.url
    this.token = options.token
    this.onStatusChange = options.onStatusChange
    this.onAgentEvent = options.onAgentEvent
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
      // 心跳保持连接
      this.heartbeatTimer = setInterval(() => {
        try {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }))
          }
        } catch {
          /* ignore */
        }
      }, 25000)
      this.emitStatus('open')
    }

    this.ws.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        const msg = JSON.parse(raw) as InboundMessage
        this.handleMessage(msg)
      } catch (e) {
        console.error('[Tablet WS] 消息解析失败', e)
      }
    }

    this.ws.onclose = () => {
      this.clearHeartbeat()
      this.rejectAllPending(new Error('连接已关闭'))
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
      case 'agent_event':
        this.onAgentEvent?.({
          sessionId: msg.sessionId,
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect) this.openSocket()
    }, 2000)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private emitStatus(status: 'connecting' | 'open' | 'closed' | 'error', info?: string): void {
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

  listChannels(): Promise<unknown> {
    return this.sendCommand({ type: 'list_channels' })
  }

  sessionDetail(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'session_detail', sessionId })
  }

  getSdkMessages(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'get_sdk_messages', sessionId })
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

  sendMessage(payload: { sessionId: string; userMessage: string; channelId: string; modelId?: string; workspaceId?: string }): Promise<unknown> {
    return this.sendCommand({ type: 'send_message', ...payload })
  }

  stopAgent(sessionId: string): Promise<unknown> {
    return this.sendCommand({ type: 'stop_agent', sessionId })
  }
}

/** 派生默认 WS 地址（与当前 HTTP 页面同源，补 /ws） */
export function defaultWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}
