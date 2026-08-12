/**
 * 平板端 electronAPI 桥
 *
 * 分层职责：
 * 1. 事件桥：onAgentStreamEvent 等 IPC 事件注册器 → WS agent_event 分发。
 *    桌面渲染层（useGlobalAgentListeners / AgentView / LeftSidebar 依赖树）只感知
 *    electronAPI 形状；平板通过 emitTabletAgentStreamEvent() 把 WS 事件喂回注册器，
 *    使桌面组件的事件处理逻辑 100% 复用（与桌面 IPC AgentStreamEvent 同形状）。
 * 2. 命令映射：AgentView / LeftSidebar 用到的 IPC 命令 → WS 远程命令。
 * 3. 降级层：平板无意义的桌面能力（本地文件对话框 / 知识库 / 进程面板 / 分叉回退）→
 *    安全空实现或明确报错，避免复用组件崩溃或出现“可点但无效果”的伪按钮。
 */

import type { AgentStreamEvent, AgentStreamCompletePayload, StreamChunkEvent, StreamReasoningEvent, StreamCompleteEvent, StreamErrorEvent, StreamToolActivityEvent, GenerateTitleInput } from '@profer/shared'
import { CHAT_IPC_CHANNELS, BUILTIN_DEFAULT_ID, BUILTIN_DEFAULT_PROMPT } from '@profer/shared'

/** WsClient 满足的最小远程命令面（与 ws-client.ts 方法一一对应） */
interface TabletRemoteClient {
  listSessions(): Promise<unknown>
  listWorkspaces(): Promise<unknown>
  createWorkspace(name: string): Promise<unknown>
  deleteSession(sessionId: string): Promise<unknown>
  /** 分叉会话 */
  forkSession(payload: { sessionId: string; upToMessageUuid?: string }): Promise<unknown>
  /** 快照回退 */
  rewindSession(payload: { sessionId: string; assistantMessageUuid: string }): Promise<unknown>
  /** 置顶/取消置顶 */
  toggleSessionPin(sessionId: string): Promise<unknown>
  /** 归档/取消归档 */
  toggleSessionArchive(sessionId: string): Promise<unknown>
  /** 移动会话到项目 */
  moveSessionToWorkspace(payload: { sessionId: string; targetWorkspaceId: string }): Promise<unknown>
  /** 设置推理档位（null=恢复全局默认） */
  updateSessionThinkingLevel(sessionId: string, level: string | null): Promise<unknown>
  getUserProfile(): Promise<unknown>
  listChannels(): Promise<unknown>
  createSession(payload: { title?: string; channelId?: string; workspaceId?: string; modelId?: string }): Promise<unknown>
  ensureProjectDraftSession(payload: { workspaceId: string; channelId?: string; modelId?: string }): Promise<unknown>
  renameSession(sessionId: string, title: string): Promise<unknown>
  getSdkMessages(
    sessionId: string,
    opts?: { before?: number; targetMessages?: number },
  ): Promise<unknown>
  sendMessage(payload: { sessionId: string; userMessage: string; channelId: string; modelId?: string; workspaceId?: string }): Promise<unknown>
  /** 向正在运行的 Agent 注入消息（对齐桌面 queueAgentMessage：interrupt 软打断 / uuid 幂等） */
  queueMessage(payload: {
    sessionId: string
    userMessage: string
    rawUserMessage?: string
    uuid?: string
    interrupt?: boolean
    mentionedSkills?: string[]
    mentionedMcpServers?: string[]
    mentionedSessionIds?: string[]
  }): Promise<unknown>
  updateSessionModel(sessionId: string, channelId: string, modelId?: string): Promise<unknown>
  updateSessionRuntime(sessionId: string, runtime: 'claude' | 'pi'): Promise<unknown>
  updatePermissionMode(sessionId: string, mode: 'auto' | 'plan' | 'bypassPermissions'): Promise<unknown>
  stopAgent(sessionId: string): Promise<unknown>
  // ---- 交互式问答/审批响应（AskUserQuestion / 权限审批 / ExitPlanMode） ----
  respondPermission(requestId: string, behavior: 'allow' | 'deny', alwaysAllow?: boolean): Promise<unknown>
  respondAskUser(requestId: string, answers: Record<string, string>): Promise<unknown>
  respondExitPlanMode(requestId: string, action: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback', feedback?: string): Promise<unknown>
  // ---- Chat（聊天工具）----
  listConversations(): Promise<unknown>
  createConversation(payload: { title?: string; modelId?: string; channelId?: string }): Promise<unknown>
  getConversationMessages(conversationId: string): Promise<unknown>
  getRecentMessages(conversationId: string, limit: number): Promise<unknown>
  updateConversationTitle(conversationId: string, title: string): Promise<unknown>
  updateConversationModel(conversationId: string, modelId?: string, channelId?: string): Promise<unknown>
  deleteConversation(conversationId: string): Promise<unknown>
  toggleConversationPin(conversationId: string): Promise<unknown>
  toggleConversationArchive(conversationId: string): Promise<unknown>
  searchChatMessages(query: string): Promise<unknown>
  searchAgentSessionMessages(query: string): Promise<unknown>
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
  }): Promise<unknown>
  chatStopGeneration(conversationId: string): Promise<unknown>
  chatDeleteMessage(conversationId: string, messageId: string): Promise<unknown>
  chatTruncateMessagesFrom(conversationId: string, messageId: string, preserveFirstMessageAttachments?: boolean): Promise<unknown>
  chatUpdateContextDividers(conversationId: string, dividers: string[]): Promise<unknown>
  chatGenerateTitle(input: GenerateTitleInput): Promise<unknown>
  chatSaveAttachment(input: { conversationId: string; filename: string; mediaType: string; data: string }): Promise<unknown>
  chatDeleteAttachment(localPath: string): Promise<unknown>
  chatReadAttachment(localPath: string): Promise<unknown>
}

let remoteClient: TabletRemoteClient | null = null

/** 在 WebSocket 建连后注入，使原生桌面组件沿用 electronAPI 形状调用远程服务。 */
export function setTabletRemoteClient(client: TabletRemoteClient | null): void {
  remoteClient = client
}

// ===== 会话消息传输层懒加载分页状态 =====
//
// 移动端打开会话时不一次性拉全量，而是按完整 turn 惰性分页（见服务端
// paginateSDKMessages）。stub 为每个 sessionId 维护已累计的消息、起点游标与还有更早的标记；
// AgentView 每次 getAgentSessionSDKMessages(sessionId) 都拿到当前已累计的有序数组。

interface SdkMessagesPageState {
  /** 已累计的完整有序 SDKMessage（按 startIndex 顺序，从最早累积到当前尾部） */
  messages: unknown[]
  /** 已累计部分在服务端完整消息数组中的起点索引（补更早时作为 before 游标） */
  startIndex: number
  /** 更早是否还有消息 */
  hasMore: boolean
}

const sdkMessagesPageCache = new Map<string, SdkMessagesPageState>()

/** 缓存会话数上限：触顶加载/多会话切换会在 stub 侧堆积整份消息数组，无界会随会话数无限增长。
 *  超出上限时淘汰最久未写入的会话（Map 迭代序即插入序）。 */
const SDK_MESSAGES_CACHE_MAX_SESSIONS = 20

/** 写入并执行 LRU 淘汰：delete+set 把该 key 移到末尾（视为最近使用），超出上限删头部最久未用。 */
function setCachedPage(sessionId: string, state: SdkMessagesPageState): void {
  sdkMessagesPageCache.delete(sessionId)
  sdkMessagesPageCache.set(sessionId, state)
  while (sdkMessagesPageCache.size > SDK_MESSAGES_CACHE_MAX_SESSIONS) {
    const oldest = sdkMessagesPageCache.keys().next().value
    if (oldest === undefined) break
    sdkMessagesPageCache.delete(oldest)
  }
}

/** 返回当前会话已累计的消息数组（无则返回空数组，由调用方触发迁移）。 */
function getCachedSdkMessages(sessionId: string): unknown[] {
  return sdkMessagesPageCache.get(sessionId)?.messages ?? []
}

// ===== 分页合并辅助 =====

/** 生成单条 SDKMessage 的去重键。优先 uuid；无 uuid 时回退到 type + 内容哈希。
 *  result / system(无 uuid) 等消息靠内容指纹去重，保证跨分页合并时不重不漏。 */
function sdkMessageKey(msg: unknown): string {
  const m = msg as { uuid?: string; type?: string; message?: unknown; _createdAt?: number; error?: unknown }
  if (typeof m?.uuid === 'string' && m.uuid.length > 0) return `u:${m.uuid}`
  // 无 uuid：用 type + message 内容 + _createdAt 组合指纹；同一消息跨分页返回时 fingerprint 不变，
  // 不同消息即使 type 相同、内容长度相近也能靠内容差异区分（降低哈希碰撞风险）。
  try {
    const content = JSON.stringify(m?.message ?? m?.error ?? {})
    // 简单可复现的滚动哈希（djb2），避免全量内容字符串占用内存/日志。
    let h = 5381
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) + h + content.charCodeAt(i)) | 0
    }
    return `h:${m?.type ?? '?'}:${h}:${typeof m?._createdAt === 'number' ? m._createdAt : ''}`
  } catch {
    return `h:${m?.type ?? '?'}:${String(msg).slice(0, 64)}`
  }
}

/**
 * 稳健合并"旧缓存 + 最新分页窗口"，返回新的 SdkMessagesPageState。
 *
 * 背景：服务端 paginateSDKMessages 会把窗口起点快进到 user-turn 边界，且两次分页之间
 * 若新增消息数超过 targetMessages，新窗口起点与旧缓存尾部之间可能存在整段消息。
 * 用 page.startIndex - prev.startIndex 切旧缓存前缀会丢消息。这里改为基于去重键：
 *  1. 在旧缓存 messages 中定位 latest 首条消息（去重键逐条比对），找到重叠点。
 *  2. 找不到重叠点（两窗口完全不重叠）→ 丢弃旧缓存，以最新窗口为准（宁可重拉更早，也不丢最新）。
 *  3. 找到重叠点 → 旧缓存前缀（重叠点之前）+ latest（自重叠点起的最新连续窗口）。
 * 这样无论 startIndex 如何快进、新增多少条，都保证尾部消息完整、前缀不重复。
 */
function mergePageWithCache(
  prevMessages: unknown[],
  latest: unknown[],
  prevStartIndex: number,
  pageStartIndex: number,
  pageHasMore: boolean,
): SdkMessagesPageState {
  if (latest.length === 0) {
    return { messages: prevMessages, startIndex: prevStartIndex, hasMore: pageHasMore }
  }

  const firstKey = sdkMessageKey(latest[0])
  // 从旧缓存末尾向前找 latest 首条消息的匹配位置（重叠点通常在旧缓存尾部附近）。
  let overlap = -1
  for (let i = prevMessages.length - 1; i >= 0; i--) {
    if (sdkMessageKey(prevMessages[i]) === firstKey) {
      overlap = i
      break
    }
  }

  if (overlap < 0) {
    // 完全不重叠：新窗口已经越过旧缓存尾部（新增消息过多）。以后面连续的最新窗口为准，
    // 避免用失效的索引差值拼接出中间缺口的坏序列。更早历史由触顶加载按 before 补齐。
    return { messages: latest, startIndex: pageStartIndex, hasMore: pageHasMore }
  }

  // 有重叠：旧缓存 [0, overlap) 前缀 + latest 全部（latest 从重叠点开始是连续更新的尾部）。
  const prefix = prevMessages.slice(0, overlap)
  return {
    messages: [...prefix, ...latest],
    // startIndex 仍是前缀首条消息的绝对索引（= 旧起点），与 overlap 无关。
    startIndex: prevStartIndex,
    hasMore: pageHasMore,
  }
}

// ===== 事件桥：注册器（供桌面组件注册）+ emit（供平板 WS 层喂事件） =====

type Listener<T> = (payload: T) => void

const agentStreamEventListeners = new Set<Listener<AgentStreamEvent>>()
const agentStreamCompleteListeners = new Set<Listener<AgentStreamCompletePayload>>()
const agentStreamErrorListeners = new Set<Listener<{ sessionId: string; error: unknown }>>()
const agentTitleUpdatedListeners = new Set<Listener<{ sessionId: string; title: string }>>()
const agentSessionUpdatedListeners = new Set<Listener<{ session: unknown }>>()
const todoAgentSessionReadyListeners = new Set<Listener<unknown>>()
const runtimeProcessesChangedListeners = new Set<Listener<unknown>>()

// ---- Chat 流式事件注册器（useGlobalChatListeners 消费；WS chat_event 按通道喂回） ----
const chatChunkListeners = new Set<Listener<StreamChunkEvent>>()
const chatReasoningListeners = new Set<Listener<StreamReasoningEvent>>()
const chatCompleteListeners = new Set<Listener<StreamCompleteEvent>>()
const chatErrorListeners = new Set<Listener<StreamErrorEvent>>()
const chatToolActivityListeners = new Set<Listener<StreamToolActivityEvent>>()

function register<T>(set: Set<Listener<T>>, cb: Listener<T>): () => void {
  set.add(cb)
  return () => { set.delete(cb) }
}

function emitTo<T>(set: Set<Listener<T>>, payload: T): void {
  for (const listener of [...set]) {
    try {
      listener(payload)
    } catch (e) {
      console.error('[Tablet] 事件监听器执行异常', e)
    }
  }
}

/** 平板 WS agent_event → 桌面 IPC AgentStreamEvent 形状，喂给 useGlobalAgentListeners。 */
export function emitTabletAgentStreamEvent(event: AgentStreamEvent): void {
  emitTo(agentStreamEventListeners, event)
}

export function emitTabletChatStreamEvent(channel: string, payload: unknown): void {
  switch (channel) {
    case CHAT_IPC_CHANNELS.STREAM_CHUNK:
      emitTo(chatChunkListeners, payload as StreamChunkEvent)
      break
    case CHAT_IPC_CHANNELS.STREAM_REASONING:
      emitTo(chatReasoningListeners, payload as StreamReasoningEvent)
      break
    case CHAT_IPC_CHANNELS.STREAM_COMPLETE:
      emitTo(chatCompleteListeners, payload as StreamCompleteEvent)
      break
    case CHAT_IPC_CHANNELS.STREAM_ERROR:
      emitTo(chatErrorListeners, payload as StreamErrorEvent)
      break
    case CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY:
      emitTo(chatToolActivityListeners, payload as StreamToolActivityEvent)
      break
    default:
      console.warn('[Tablet] 未知 Chat 流式通道:', channel)
  }
}

/** 供 future WS 协议扩展时调用（当前 remote-service 暂无对应事件源）。 */
export function emitTabletAgentStreamComplete(payload: AgentStreamCompletePayload): void {
  emitTo(agentStreamCompleteListeners, payload)
}

/** 用户主动停止标记（stopAgent 记录，run_idle 桥接 STREAM_COMPLETE 时消费）。 */
const tabletStoppedByUser = new Set<string>()

/** 取并清除指定会话的用户停止标记（未标记返回 false）。 */
export function consumeTabletStoppedByUser(sessionId: string): boolean {
  const stopped = tabletStoppedByUser.has(String(sessionId))
  tabletStoppedByUser.delete(String(sessionId))
  return stopped
}

// ===== 降级工具 =====

function noop(..._args: unknown[]): unknown {
  return undefined
}

/** 常见但平板不需要真正实现的方法 → 安全空实现 */
const safeNoop = (): Promise<unknown> => Promise.resolve(undefined)

/** 平板明确不支持的能力 → 拒绝并给出中文提示（调用方 catch 后 toast 呈现） */
const unsupported = (what: string): Promise<never> =>
  Promise.reject(new Error(`平板暂不支持${what}`))

/**
 * 安装平板版 electronAPI 桥。
 * 在业务 React 渲染之前调用（main.tsx 顶部）。
 */
export function installElectronApiStub(): void {
  const existing = (globalThis as unknown as { electronAPI?: unknown }).electronAPI
  if (existing) return // 若已存在（Electron 环境）则不覆盖

  const stub: Record<string, unknown> = {
    // ---- 事件桥（注册器；WS 事件由 emitTabletAgentStreamEvent 喂回） ----
    onAgentStreamEvent: (cb: Listener<AgentStreamEvent>) => register(agentStreamEventListeners, cb),
    onAgentStreamComplete: (cb: Listener<AgentStreamCompletePayload>) => register(agentStreamCompleteListeners, cb),
    onAgentStreamError: (cb: Listener<{ sessionId: string; error: unknown }>) => register(agentStreamErrorListeners, cb),
    onAgentTitleUpdated: (cb: Listener<{ sessionId: string; title: string }>) => register(agentTitleUpdatedListeners, cb),
    onAgentSessionUpdated: (cb: Listener<{ session: unknown }>) => register(agentSessionUpdatedListeners, cb),
    onTodoAgentSessionReady: (cb: Listener<unknown>) => register(todoAgentSessionReadyListeners, cb),
    onRuntimeProcessesChanged: (cb: Listener<unknown>) => register(runtimeProcessesChangedListeners, cb),
    // ---- Chat 流式事件注册器（useGlobalChatListeners 消费；WS chat_event 按通道喂回） ----
    onStreamChunk: (cb: Listener<StreamChunkEvent>) => register(chatChunkListeners, cb),
    onStreamReasoning: (cb: Listener<StreamReasoningEvent>) => register(chatReasoningListeners, cb),
    onStreamComplete: (cb: Listener<StreamCompleteEvent>) => register(chatCompleteListeners, cb),
    onStreamError: (cb: Listener<StreamErrorEvent>) => register(chatErrorListeners, cb),
    onStreamToolActivity: (cb: Listener<StreamToolActivityEvent>) => register(chatToolActivityListeners, cb),
    // 大刷新后恢复活跃流：平板刷新时事件已通过 WS 继续推送（断线期间的历史事件丢失），
    // 无需 main 回放，返回空列表即可（桌面调用方会遍历 sessionIds 写 streaming 占位）。
    restoreActiveAgentStreams: () => Promise.resolve([]),

    // ---- 命令映射：Agent 核心动作 → WS 远程命令 ----
    sendAgentMessage: (input: Record<string, unknown>) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.sendMessage({
        sessionId: String(input.sessionId || ''),
        userMessage: String(input.userMessage || ''),
        channelId: String(input.channelId || ''),
        modelId: input.modelId as string | undefined,
        workspaceId: input.workspaceId as string | undefined,
      })
    },
    queueAgentMessage: async (input: Record<string, unknown>) => {
      // 平板队列消息必须走主进程 queue_message 指令（注入正在运行的 Agent）：
      // 直接降级为 send_message 会被编排器并发保护拒绝（"上一条消息仍在处理中"），
      // 表现为“队列消息立即插入不了”。这里保留 uuid/interrupt/mention 语义。
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      try {
        return await remoteClient.queueMessage({
          sessionId: String(input.sessionId || ''),
          userMessage: String(input.userMessage || ''),
          rawUserMessage: typeof input.rawUserMessage === 'string' ? input.rawUserMessage : undefined,
          uuid: typeof input.uuid === 'string' ? input.uuid : undefined,
          interrupt: input.interrupt === true,
          mentionedSkills: Array.isArray(input.mentionedSkills) ? input.mentionedSkills as string[] : undefined,
          mentionedMcpServers: Array.isArray(input.mentionedMcpServers) ? input.mentionedMcpServers as string[] : undefined,
          mentionedSessionIds: Array.isArray(input.mentionedSessionIds) ? input.mentionedSessionIds as string[] : undefined,
        })
      } catch (error) {
        // 目标不再活跃（上一轮 turn 已结束、renderer 尚未同步）：与桌面
        // isQueueTargetNoLongerActiveError → startNewRun 降级一致，转为直接发送新 run。
        if (error instanceof Error && /^\[Agent 编排\] 会话未运行，无法追加消息: /.test(error.message)) {
          return remoteClient.sendMessage({
            sessionId: String(input.sessionId || ''),
            userMessage: String(input.userMessage || ''),
            channelId: String(input.channelId || ''),
            modelId: input.modelId as string | undefined,
            workspaceId: input.workspaceId as string | undefined,
          })
        }
        throw error
      }
    },
    getAgentSessionSDKMessages: async (
      sessionId: string,
      opts?: { before?: number; targetMessages?: number; pullEarlier?: boolean; paginateFirst?: boolean },
    ) => {
      if (!remoteClient) return Promise.resolve([])
      // pullEarlier：由 AgentView 在移动端“触顶加载更早”时触发，用缓存已追踪的 startIndex 补前页。
      if (opts && opts.pullEarlier === true) {
        const prev = sdkMessagesPageCache.get(sessionId)
        if (prev && prev.hasMore && prev.startIndex > 0) {
          const res = await remoteClient.getSdkMessages(sessionId, {
            before: prev.startIndex,
            targetMessages: opts.targetMessages ?? 20,
          })
          const page = res as { messages?: unknown[]; startIndex?: number; hasMore?: boolean; total?: number }
          if (Array.isArray(page?.messages) && typeof page?.startIndex === 'number') {
            const merged = [...(page.messages as unknown[]), ...prev.messages]
            setCachedPage(sessionId, {
              messages: merged,
              startIndex: page.startIndex,
              hasMore: page.hasMore !== false,
            })
          }
        }
        return sdkMessagesPageCache.get(sessionId)?.messages ?? []
      }
      // 明确请求“更早一页”用 before（兼容外部调用者）。
      if (opts && opts.before !== undefined) {
        const res = await remoteClient.getSdkMessages(sessionId, {
          before: opts.before,
          targetMessages: opts.targetMessages,
        })
        const page = res as { messages?: unknown[]; startIndex?: number; total?: number; hasMore?: boolean }
        const incoming = Array.isArray(page?.messages) ? page.messages as unknown[] : []
        // 旧端不支持分页（返回原始数组而非 {messages,startIndex,...}）→退回：直接返回全量。
        if (!Array.isArray(page?.messages) || typeof page?.startIndex !== 'number') {
          setCachedPage(sessionId, {
            messages: Array.isArray(res) ? (res as unknown[]) : [],
            startIndex: 0,
            hasMore: false,
          })
          return sdkMessagesPageCache.get(sessionId)!.messages
        }
        const prev = sdkMessagesPageCache.get(sessionId)
        if (prev && typeof prev.startIndex === 'number' && prev.startIndex >= page.startIndex) {
          // 新页起点 == 上一页起点，说明服务端该档没更早内容了（已到顶），保持现状。
          if (incoming.length === prev.messages.length) {
            return prev.messages
          }
        }
        // 新页覆盖 [page.startIndex, before)；合并为：新页 + 已累计（有序）。
        const merged = [...incoming, ...(prev?.messages ?? [])]
        setCachedPage(sessionId, {
          messages: merged,
          startIndex: page.startIndex,
          hasMore: page.hasMore !== false,
        })
        return merged
      }
      // 无任何分页标记（opts 为空）：返回全量（与桌面无参语义一致）。
      // 移动端侧栏悬浮预览（SessionMiniMapPopover）等走全量，计数/预览恢复真实内容。
      if (!opts || opts.paginateFirst !== true) {
        const raw = await remoteClient.getSdkMessages(sessionId)
        return Array.isArray(raw) ? (raw as unknown[]) : []
      }
      // 显式 paginateFirst：打开会话首帧取最新 targetMessages 条；已有缓存则刷新尾部并保留更早。
      const prev = sdkMessagesPageCache.get(sessionId)
      if (prev && prev.messages.length > 0) {
        // 刷新尾部（流式/新 turn 处理后）：拉最新窗口并向前合并，保留已加载的更早历史。
        const res = await remoteClient.getSdkMessages(sessionId, {
          targetMessages: opts.targetMessages ?? 4,
        })
        const page = res as { messages?: unknown[]; startIndex?: number; total?: number; hasMore?: boolean }
        if (Array.isArray(page?.messages) && typeof page?.startIndex === 'number') {
          const latest = page.messages as unknown[]
          // 稳健合并：不依赖 page.startIndex - prev.startIndex 的绝对索引差。
          // startIndex 会被 user-turn 边界快进，两次分页之间若新增消息数 > targetMessages，
          // 新窗口起点会跳过旧缓存尾部之间的整段消息，用索引差值切 prefix 会丢消息。
          // 这里改成"按去重键求前缀"：从 prev 里找到 latest 首条消息的位置，截断重叠，避免丢/重。
          const merged = mergePageWithCache(prev.messages, latest, prev.startIndex, page.startIndex, page.hasMore !== false)
          setCachedPage(sessionId, merged)
          return merged.messages
        }
        // 旧端返回原始数组：直接用新数据覆盖。
        const raw = Array.isArray(res) ? (res as unknown[]) : prev.messages
        setCachedPage(sessionId, { messages: raw, startIndex: 0, hasMore: false })
        return raw
      }
      // 首帧（无缓存）：拉最新 targetMessages 条，奠基缓存。
      const res = await remoteClient.getSdkMessages(sessionId, {
        targetMessages: opts.targetMessages ?? 4,
      })
      if (Array.isArray(res)) {
        // 旧端/未分页：直接返回原始数组。
        setCachedPage(sessionId, { messages: res as unknown[], startIndex: 0, hasMore: false })
        return res
      }
      const page = res as { messages?: unknown[]; startIndex?: number; total?: number; hasMore?: boolean }
      const msgs = Array.isArray(page?.messages) ? page.messages as unknown[] : []
      setCachedPage(sessionId, {
        messages: msgs,
        startIndex: typeof page?.startIndex === 'number' ? page.startIndex : 0,
        hasMore: page?.hasMore !== false,
      })
      return msgs
    },
    getSdkMessagesHasMore: (sessionId: string) => {
      return sdkMessagesPageCache.get(sessionId)?.hasMore ?? false
    },
    updateAgentSessionModel: (sessionId: string, channelId: string, modelId?: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.updateSessionModel(sessionId, channelId, modelId).then((r) => {
        // 契约兜底：旧版服务端可能只返回 { channelId, modelId }，补全 id 等字段，
        // 保证桌面组件 .then((updated) => updated.id / updated.updatedAt) 拿到完整对象。
        const updated = (r ?? {}) as Record<string, unknown>
        return { ...updated, id: updated.id ?? sessionId }
      })
    },
    updateSessionAgentRuntime: (sessionId: string, runtime: 'claude' | 'pi') => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.updateSessionRuntime(sessionId, runtime)
    },
    updateSessionPermissionMode: (sessionId: string, mode: 'auto' | 'plan' | 'bypassPermissions') => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.updatePermissionMode(sessionId, mode)
    },
    // ---- 交互式问答/审批响应：AskUserQuestion、权限审批、ExitPlanMode 的选项必须真正回传给主进程 ----
    respondAskUser: ({ requestId, answers }: { requestId: string; answers: Record<string, string> }) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.respondAskUser(requestId, answers)
    },
    respondPermission: ({ requestId, behavior, alwaysAllow }: { requestId: string; behavior: 'allow' | 'deny'; alwaysAllow?: boolean }) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.respondPermission(requestId, behavior, alwaysAllow ?? false)
    },
    respondExitPlanMode: ({ requestId, action, feedback }: { requestId: string; action: string; feedback?: string }) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.respondExitPlanMode(requestId, action as 'approve_auto' | 'approve_edit' | 'deny' | 'feedback', feedback)
    },
    stopAgent: (sessionId: string) => {
      // 记录用户主动停止标记：run_idle 桥接 STREAM_COMPLETE 时用（stoppedByUser 展示“已停止”）
      if (sessionId) tabletStoppedByUser.add(String(sessionId))
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.stopAgent(sessionId)
    },
    // ---- 命令映射：LeftSidebar 会话管理（已在 WebSocket 建连后注入） ----
    listAgentSessions: () => remoteClient?.listSessions() ?? Promise.resolve([]),
    createAgentSession: async (title?: string, channelId?: string, workspaceId?: string, modelId?: string) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      const created = await remoteClient.createSession({ title, channelId, workspaceId, modelId }) as { sessionId: string; title: string }
      return { id: created.sessionId, title: created.title, channelId, modelId, workspaceId, createdAt: Date.now(), updatedAt: Date.now() }
    },
    ensureProjectDraftAgentSession: async (workspaceId: string, channelId?: string, modelId?: string) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      // 复用语义：项目已有草稿会话则返回它（不再每次新建），对齐桌面 ensureProjectDraftAgentSession
      const created = await remoteClient.ensureProjectDraftSession({ workspaceId, channelId, modelId }) as { sessionId: string; title: string; draft?: boolean }
      return { id: created.sessionId, title: created.title, channelId, modelId, workspaceId, draft: created.draft ?? true, createdAt: Date.now(), updatedAt: Date.now() }
    },
    updateAgentSessionTitle: (id: string, title: string) => remoteClient?.renameSession(id, title) ?? Promise.reject(new Error('移动端连接未就绪')),
    getAgentSessionMeta: async (id: string) => {
      const sessions = await (remoteClient?.listSessions() ?? Promise.resolve([])) as Array<{ id: string }>
      return sessions.find((session) => session.id === id)
    },
    // 优先走真实工作区列表（list_workspaces 由 remote-service 返回桌面同构数据，含真实项目名称）；
    // 旧版服务端无此指令时只兜底默认工作区（不再从会话归纳 workspaceId，避免孤儿会话伪装成幽灵项目）。
    listAgentWorkspaces: async () => {
      if (remoteClient) {
        try {
          const workspaces = await remoteClient.listWorkspaces() as Array<{ id: string; name: string; slug: string; type?: string; createdAt?: number; updatedAt?: number }> | undefined
          if (Array.isArray(workspaces) && workspaces.length > 0) {
            // 与 main.tsx loadSessions 的团队过滤一致：LeftSidebar 会主动调本方法刷新侧栏，
            // 若不过滤会把团队工作区重新塞回 agentWorkspacesAtom，覆盖 loadSessions 的过滤结果。
            return workspaces
              .filter((w) => w.type !== 'team')
              .map((w) => ({
                id: w.id,
                name: w.name,
                slug: w.slug,
                type: w.type ?? 'personal',
                createdAt: w.createdAt ?? 0,
                updatedAt: w.updatedAt ?? 0,
              }))
          }
        } catch {
          /* 服务端不支持时走下面的兜底 */
        }
      }
      // 兜底：服务端不支持 list_workspaces 时，只回退默认工作区。
      // ⚠️ 不能从历史会话归纳全部 workspaceId：被删除项目的会话仍然存在（孤儿会话），
      // 归纳会把已删除项目以 UUID 名字伪装成“幽灵项目”重新出现在平板侧栏。
      return [{ id: 'default', name: '默认工作区', slug: 'default', type: 'personal', createdAt: 0, updatedAt: 0 }]
    },
    // 删除会话：走 remote-service 的 delete_session 指令（对齐桌面 stop-and-wait + 清理持久化语义）。
    // ⚠️ 必须显式 stub：缺省时 Proxy noop 会让 UI“假删除成功”（本地列表移除、主进程未删，刷新后复活）。
    deleteAgentSession: async (sessionId: string) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      await remoteClient.deleteSession(sessionId)
    },
    // 创建项目：通过 remote-service 的 create_workspace 指令在远端主实例创建。
    // ⚠️ 必须显式 stub：缺省时 Proxy 兜底 noop 返回 undefined，
    // 会让左侧栏把 undefined 塞进 workspaces 列表 → find(w => w.id) 读 undefined.id 崩溃（必现白屏）。
    createAgentWorkspace: async (name: string) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      const created = await remoteClient.createWorkspace(name) as
        | { id: string; name: string; slug: string; type?: string; createdAt?: number; updatedAt?: number }
        | undefined
      if (!created || typeof created !== 'object') {
        throw new Error('创建工作区失败：远端返回异常')
      }
      return {
        id: created.id,
        name: created.name,
        slug: created.slug,
        type: created.type ?? 'personal',
        createdAt: created.createdAt ?? 0,
        updatedAt: created.updatedAt ?? 0,
      }
    },
    // 重命名/删除/排序：平板暂无对应指令，显式拒绝（绝不能靠 Proxy 兜底 noop，
    // 否则“删除成功”是假的、重命名静默失败，且可能污染列表/造成桌面索引不一致）。
    updateAgentWorkspace: () => unsupported('重命名项目'),
    deleteAgentWorkspace: () => unsupported('删除项目'),
    reorderAgentWorkspaces: () => unsupported('项目排序'),

    // ---- 降级：只读/空数据，维持复用组件可渲染 ----
    getSettings: () => Promise.resolve({}),
    updateSettings: safeNoop,
    // 真实用户档案：从主进程 user-profile-service 读取（LeftSidebar 挂载时自动消费写入 userProfileAtom，
    // 侧栏底部用户名/头像即真实值）；旧版服务端无 get_user_profile 指令时回退默认档案。
    getUserProfile: async () => {
      if (remoteClient) {
        try {
          const profile = await remoteClient.getUserProfile() as { userName?: string; avatar?: string } | undefined
          if (profile && typeof profile === 'object') {
            return {
              userName: profile.userName || 'Profer 用户',
              avatar: profile.avatar || '',
            }
          }
        } catch {
          /* 服务端不支持，走兜底 */
        }
      }
      return { userName: 'Profer 用户', avatar: '' }
    },
    getSystemTheme: () => Promise.resolve(true),
    // SystemPromptSelector（ChatHeader）挂载时拉取提示词配置并 setConfig 覆写 promptConfigAtom：
    // 必须返回桌面同构默认配置，否则 Proxy 兜底的 undefined 会把 promptConfigAtom 覆写成 undefined，
    // 导致 defaultPromptIdAtom 等派生 atom 抛 “Cannot read properties of undefined (reading 'defaultPromptId')”，
    // 整个 Chat 视图（含 LeftSidebar 新建对话）崩溃。
    getSystemPromptConfig: () => Promise.resolve({
      prompts: [BUILTIN_DEFAULT_PROMPT],
      defaultPromptId: BUILTIN_DEFAULT_ID,
      appendDateTimeAndUserName: true,
    }),
    // 工具选择器：平板不修改工具开关，返回空列表（避免 undefined 覆写 chatToolsAtom）
    getChatTools: () => Promise.resolve([]),
    // ---- Chat（聊天工具）命令映射：桌面 ChatView / LeftSidebar / useGlobalChatListeners 的 IPC 命令 → WS 远程命令 ----
    listConversations: () => remoteClient?.listConversations() ?? Promise.resolve([]),
    createConversation: (title?: string, modelId?: string, channelId?: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.createConversation({ title, modelId, channelId })
    },
    getConversationMessages: (conversationId: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.getConversationMessages(conversationId)
    },
    getRecentMessages: (conversationId: string, limit: number) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.getRecentMessages(conversationId, limit)
    },
    updateConversationTitle: (conversationId: string, title: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.updateConversationTitle(conversationId, title)
    },
    updateConversationModel: (conversationId: string, modelId?: string, channelId?: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.updateConversationModel(conversationId, modelId, channelId)
    },
    deleteConversation: (conversationId: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.deleteConversation(conversationId)
    },
    togglePinConversation: (conversationId: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.toggleConversationPin(conversationId)
    },
    toggleArchiveConversation: (conversationId: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.toggleConversationArchive(conversationId)
    },
    searchConversationMessages: (query: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.searchChatMessages(query)
    },
    searchAgentSessionMessages: (query: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.searchAgentSessionMessages(query)
    },
    sendMessage: (input: Record<string, unknown>) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      const conv = input as {
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
      }
      return remoteClient.chatSendMessage({
        conversationId: conv.conversationId,
        userMessage: conv.userMessage,
        channelId: conv.channelId,
        modelId: conv.modelId,
        contextLength: conv.contextLength,
        contextDividers: conv.contextDividers,
        attachments: conv.attachments,
        knowledgeReferences: conv.knowledgeReferences,
        thinkingEnabled: conv.thinkingEnabled,
        systemMessage: conv.systemMessage,
        enabledToolIds: conv.enabledToolIds,
      })
    },
    stopGeneration: (conversationId: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatStopGeneration(conversationId)
    },
    deleteMessage: (conversationId: string, messageId: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatDeleteMessage(conversationId, messageId)
    },
    truncateMessagesFrom: (conversationId: string, messageId: string, preserveFirstMessageAttachments?: boolean) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatTruncateMessagesFrom(conversationId, messageId, preserveFirstMessageAttachments)
    },
    updateContextDividers: (conversationId: string, dividers: string[]) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatUpdateContextDividers(conversationId, dividers)
    },
    generateTitle: (input: GenerateTitleInput) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatGenerateTitle(input)
    },
    saveAttachment: (input: { conversationId: string; filename: string; mediaType: string; data: string }) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatSaveAttachment(input)
    },
    deleteAttachment: (localPath: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatDeleteAttachment(localPath)
    },
    readAttachment: (localPath: string) => {
      if (!remoteClient) return Promise.reject(new Error('移动端连接未就绪'))
      return remoteClient.chatReadAttachment(localPath)
    },
    getChannels: () => Promise.resolve([]),
    // ChannelPlanQuotaBadge（Chat 模型选择器/会话头部展示渠道额度）会调用 getChannelPlanQuota：
    // 必须返回明确的“不支持”结果对象，不能靠 Proxy 兜底 undefined——fetchChannelPlanQuota
    // 会把返回值写进缓存，若写入 undefined，后续切换模型时 getCachedPlanQuota 读
    // cached.result.updatedAt 会抛 “Cannot read properties of undefined (reading 'updatedAt')”。
    getChannelPlanQuota: () => Promise.resolve({
      supported: false,
      provider: 'custom',
      windows: [],
      updatedAt: Date.now(),
      message: '平板暂不支持订阅额度查询',
    }),
    // ModelSelector 打开时会调用 listChannels 刷新渠道列表：
    // 必须返回 WS 真实渠道，否则空数组会覆盖平板已喂好的 channelsAtom，模型选择器变成空列表。
    // 注意：WS 返回的是桌面渠道原始形状，没有平板补丁后的 enabled 语义（桌面 enabled 由
    // ChannelSettings 持久化，WS 不应用用户设置）。这里与 loadChannels 一样补全 enabled，
    // 否则 ModelSelector 的 modelOptions（enabled && models[].enabled）恒空 → “暂无可用模型”。
    listChannels: async () => {
      const data = await (remoteClient?.listChannels() ?? Promise.resolve([]))
      return (Array.isArray(data) ? data : []).map((c) => ({
        ...c,
        enabled: true,
        models: ((c as { models?: Array<{ id?: string }> }).models || []).map((m) => ({ ...m, enabled: true })),
      }))
    },
    getModels: () => Promise.resolve([]),
    getWorkspaceCapabilities: () => Promise.resolve(null),
    getWorkspaceHeatmapDaily: () => Promise.resolve([]),
    getAccountCapabilities: () => Promise.resolve({ membershipTier: 'free', canSelfConfig: true }),
    getWorkspaceFilesPath: () => Promise.resolve(null),
    getGitRepoStatus: () => Promise.resolve(null),
    getWorkspaceDirectories: () => Promise.resolve([]),
    getWorkspaceAttachedFiles: () => Promise.resolve([]),
    getSessionProcessCount: () => Promise.resolve(0),
    listSessionProcesses: () => Promise.resolve([]),
    getAgentKnowledgeReferences: () => Promise.resolve([]),
    knowledge: {
      getLibrarySnapshot: () => Promise.resolve({ items: [] }),
      // 知识库引用选择器：平板暂不支持知识库，返回空列表（必须显式返回数组，
      // 否则 Proxy 兜底的 undefined 会让调用方 snapshot.map 崩溃）
      listItems: () => Promise.resolve([]),
    },
    searchAgentSessionReferences: () => Promise.resolve([]),
    getPathForFile: () => Promise.resolve(''),
    checkPathsType: () => Promise.resolve({ directories: [], files: [] }),
    saveImageAs: safeNoop,
    openExternal: noop,
    team: { onWorkspacesSynced: () => noop },
    notifications: { show: safeNoop },

    // ---- 降级：明确拒绝（调用方 catch → toast 提示“平板暂不支持”） ----
    forkAgentSession: async (input: { sessionId: string; upToMessageUuid?: string }) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      // remote 已返回桌面同构 buildSessionItem（含 createdAt/updatedAt/draft/pinned 等），
      // 直接透传，保证 fork 后 setAgentSessions 插入的元数据与桌面一致（LeftSidebar 渲染/排序依赖）。
      return remoteClient.forkSession(input) as Promise<Record<string, unknown>>
    },
    rewindSession: async (input: { sessionId: string; assistantMessageUuid: string }) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      return remoteClient.rewindSession(input) as Promise<{ remainingMessages: number; fileRewind?: { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number } }>
    },
    // 置顶/归档/移动/推理档位：走 remote 指令（对齐桌面 IPC 语义），
    // 必须显式 stub——否则 Proxy noop 会让“置顶/归档成功”是假的，
    // 且 LeftSidebar 读 updated.pinned/updated.id 会拿到 undefined 崩溃。
    togglePinAgentSession: async (id: string) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      return remoteClient.toggleSessionPin(id) as Promise<Record<string, unknown>>
    },
    toggleArchiveAgentSession: async (id: string) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      return remoteClient.toggleSessionArchive(id) as Promise<Record<string, unknown>>
    },
    moveAgentSessionToWorkspace: async (input: { sessionId: string; targetWorkspaceId: string }) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      return remoteClient.moveSessionToWorkspace(input) as Promise<Record<string, unknown>>
    },
    updateSessionOpenAIThinkingLevel: async (sessionId: string, level: string | null) => {
      if (!remoteClient) throw new Error('移动端连接未就绪')
      return remoteClient.updateSessionThinkingLevel(sessionId, level) as Promise<Record<string, unknown>>
    },
    attachFile: () => unsupported('附加本地文件'),
    attachDirectory: () => unsupported('附加本地目录'),
    detachFile: () => unsupported('移除本地文件'),
    detachDirectory: () => unsupported('移除本地目录'),
    openFileDialog: () => unsupported('本地文件选择'),
    openFolderDialog: () => unsupported('本地目录选择'),
    getSkins: () => unsupported('皮肤管理'),
    getSkinCss: () => unsupported('皮肤管理'),
    getSkinPreview: () => unsupported('皮肤管理'),
    selectSkinZip: () => unsupported('皮肤管理'),
    selectSkinFolder: () => unsupported('皮肤管理'),
    installSkinZip: () => unsupported('皮肤管理'),
    installSkinFolder: () => unsupported('皮肤管理'),
    deleteUserSkin: () => unsupported('皮肤管理'),
    openUserSkinsFolder: () => unsupported('皮肤管理'),
    openSkinTemplateFolder: () => unsupported('皮肤管理'),
    refreshSkins: () => unsupported('皮肤管理'),
    onSkinsChanged: () => () => undefined,
    writeClipboardPreview: () => unsupported('剪贴板预览'),
    resolveAndReadFile: () => unsupported('读取本地文件'),
    saveFilesToAgentSession: () => unsupported('保存文件到会话'),
    addAgentKnowledgeReferences: () => unsupported('知识库引用'),
    removeAgentKnowledgeReference: () => unsupported('知识库引用'),
    migrateChatToAgent: () => unsupported('Chat 迁移到 Agent'),
    // 提示词编辑（PromptEditorSidebar/SystemPromptSelector 的 CRUD）：平板不暴露设置入口，
    // 必须明确拒绝，避免 Proxy 兜底 undefined 污染 promptConfigAtom / selectedPromptIdAtom。
    createSystemPrompt: () => unsupported('提示词编辑'),
    deleteSystemPrompt: () => unsupported('提示词编辑'),
    updateSystemPrompt: () => unsupported('提示词编辑'),
    setDefaultPrompt: () => unsupported('提示词编辑'),
    updateAppendSetting: () => unsupported('提示词编辑'),
    killProcess: () => unsupported('进程管理'),
  }

  // 用 Proxy 兜底：任何未显式 stub 的方法都返回安全空实现，杜绝 "undefined is not a function"
  const handler = {
    get(_target: Record<string, unknown>, prop: string): unknown {
      if (prop in _target) return _target[prop]
      // 常见 IPC 返回 Promise；纯函数返回 undefined
      if (prop.startsWith('get') || prop.endsWith('Async') || prop === 'invoke') {
        return safeNoop
      }
      return noop
    },
  }

  // 需要嵌套命名空间（electronAPI.team.*, electronAPI.chat.* 等）也 Proxy 化。
  // ⚠️ 必须返回【可调用】对象：target 是函数（typeof 为 function），否则
  // window.electronAPI.xxx() 直接调用会抛 "is not a function"（曾因返回纯对象 Proxy 踩坑）。
  const makeDeepStub = (): unknown => {
    const fn = (() => Promise.resolve(undefined)) as unknown as Record<string, unknown>
    return new Proxy(fn, {
      get: (_t, p) => {
        if (typeof p === 'string') return makeDeepStub()
        return undefined
      },
      apply: () => Promise.resolve(undefined),
    })
  }

  // 顶层也允许任意嵌套访问
  const top = new Proxy(stub, {
    get(t, p) {
      if (typeof p === 'string' && p in t) return t[p]
      if (typeof p === 'string') return makeDeepStub()
      return undefined
    },
  }) as unknown as Record<string, unknown>

  ;(globalThis as unknown as { electronAPI?: Record<string, unknown> }).electronAPI = top
  void handler
}

/** 检查当前是否在 Electron/有真实 electronAPI（供平板逻辑判断） */
export function hasRealElectronApi(): boolean {
  return Boolean((globalThis as unknown as { electronAPI?: unknown }).electronAPI)
}
