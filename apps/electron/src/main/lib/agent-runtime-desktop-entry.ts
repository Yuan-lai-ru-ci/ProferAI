/**
 * agent-runtime-desktop-entry —— 桌面 `runAgent` 走 runtime 链时的**宿主侧入口**。
 *
 * 定位与 `agent-service.ts` 的 `runAgentRuntimeHeadless` 同源：它负责「IPC / 渲染层」这一层
 * 的副作用，把引擎无关的一轮 run 交给共享入口 `runRuntimeHeadlessEntry`（策略快照、终态投影、
 * 计划模式、原生 session ID、preflight 语义全部由那里唯一负责）。
 *
 * 为什么单独成一个模块而不是复用 headless 入口：桌面与 headless 的**渲染层可见投影不同**，
 * 复用会让两条入口的差异被悄悄抹平（或反过来污染 headless）：
 *
 * | 投影 | headless（飞书 / 协作 / automation） | 桌面（本模块） |
 * |---|---|---|
 * | 事件出口 | `eventBus`（+ 桥接层自己的转发） | `eventBus` **且**向请求方 webContents 直发专用 IPC |
 * | 终态 | `callbacks.onError/onComplete` | `STREAM_ERROR` / `STREAM_COMPLETE` 专用 IPC + `run_error`/`run_complete` |
 * | webContents 绑定 | 主窗口（`getMainRendererWebContents`） | **请求方** `event.sender` |
 * | 入口未读 | 无（基线即无此步） | 请求入口无条件清未读（仅 `auto` 模式生效，与旧链同位置） |
 * | draft 晋升回调 | 只广播投影 | 广播投影 **并** `await onDraftPromoted`（飞书镜像） |
 * | 标题自动命名（GAP-D1） | 由调用方注入（旧链同一实现 + 同一投影） | 同左：两者都走共享入口，差异只在投影出口 |
 * | 删除 / 分叉守卫 | 由调用方负责 | 必须由本入口在任何 claim 之前拦下 |
 *
 * 依赖全部注入（不 import agent-service，避免 orchestrator → collaboration-tools → agent-service
 * 这条既有模块环），因此本模块可以被测试直接驱动。
 *
 * 边界（不越界声明）：
 * - **不**自己读开关；调用方（`runAgent`）先 `resolveDesktopRunChain` 再决定调不调这里。
 * - **不**自己 claim / release 执行权；互斥由 coordinator 与旧链共享的 `AgentRunOwnershipRegistry` 保证。
 * - **不**发 `external_run_started`（那是 host event port 在 `runtime_started` 上的统一投影）。
 */

import type {
  AgentMessage,
  AgentRunInitiator,
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamCompletePayload,
  AgentStreamPayload,
  ProferPermissionMode,
} from '@profer/shared'
import { AGENT_IPC_CHANNELS, resolveRunInitiator } from '@profer/shared'
import type {
  AgentRuntimeCallbacks,
  AgentRuntimeQuery,
  AgentRuntimeRunHandle,
  SessionPort,
} from '@profer/agent-runtime'
import type { AgentRuntimePlanModeEvent } from './agent-runtime-plan-mode'
import type { RuntimeEntryRunContext, RuntimeEntryTitleNaming } from './agent-runtime-entry'
import { runRuntimeHeadlessEntry } from './agent-runtime-entry'
import type { RuntimeTerminalFields } from './agent-runtime-terminal-projection'

/** 请求方 webContents 的最小形态（避免把 Electron 类型带进可测试模块）。 */
export interface DesktopRuntimeSender {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

/** 桌面 runtime 入口需要的宿主能力（生产由 `agent-service.ts` 注入自己的私有实现）。 */
export interface DesktopRuntimeAgentHost {
  /** 发起本次请求的 webContents（IPC `event.sender`）。 */
  sender: DesktopRuntimeSender
  /** 绑定 session → webContents：renderer 刷新后 `restoreActiveAgentStreams` 依赖它。 */
  registerWebContents(sessionId: string, sender: DesktopRuntimeSender): void
  /** 该会话当前是否已有活跃 run（被拒绝的请求不得覆盖 owner run 的恢复记录）。 */
  isExecutionActive(sessionId: string): boolean
  beginActiveStreamBacklog(sessionId: string): void
  finishActiveStreamBacklog(sessionId: string): void
  /** 统一事件出口（`eventBus.emit`）：backlog 记录与已绑定 webContents 的转发都由它承担。 */
  emit(sessionId: string, payload: AgentStreamPayload): void
  /**
   * 请求入口无条件清未读 —— **旧链的原位置**（早于并发守卫 / 删除 / 分叉 / preflight 判定，
   * 因此「没真正启动」的请求同样清；内部按模式短路 + try/catch）。
   */
  clearUnreadOnRequestEntry(sessionId: string): void
  /** run 真正启动时按模式清未读（仅非 `auto` 模式生效；与 `applyRunStartUnreadPolicy` 同义）。 */
  applyRunStartUnreadPolicy(sessionId: string, initiator: AgentRunInitiator): void
  /** 终态未读（必须在终态广播之前执行）。 */
  applyCompletionUnreadPolicy(input: {
    sessionId: string
    initiator: AgentRunInitiator
    backgroundTasksPending?: boolean
    started: boolean
  }): void
  /** 会话元数据读取（draft 判定）。 */
  getSessionMeta(sessionId: string): AgentSessionMeta | undefined
  /** draft → 正式：写元数据并返回晋升后的会话（未晋升时 `promoted=false`）。 */
  promoteDraftSession(sessionId: string): { session: AgentSessionMeta | undefined; promoted: boolean }
  /** 广播会话投影（草稿晋升后 renderer 才能立刻看到）。 */
  publishSessionProjection(session: AgentSessionMeta): void
  /**
   * 删除 / 分叉守卫：返回拦截原因（用户可见文案），`undefined` 表示放行。
   * 旧链在 `orchestrator.sendMessage` 内、claim 之前做同一件事。
   */
  checkEntryGuards(sessionId: string): string | undefined
  /** 草稿晋升后的宿主回调（桌面用于启动飞书 Session 镜像）。 */
  onDraftPromoted?(session: AgentSessionMeta): void | Promise<void>

  // ===== runtime 入口依赖（与 `runAgentRuntimeHeadless` 完全同源）=====
  /** 与 coordinator 共用的原子执行权；保护 entry 准备阶段，非产品测试宿主可省略。 */
  execution?: import('./agent-runtime-entry').RuntimeHeadlessEntryDeps['execution']
  /** 解析每轮运行环境（runtime / cwd / 工具装配基座 / 策略上下文）。 */
  resolveRunContext(input: AgentSendInput): RuntimeEntryRunContext
  /** 执行一轮 run（生产实现是真实 coordinator）。 */
  run(query: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks): AgentRuntimeRunHandle
  /** 会话端口（原生 session 持久化 + preflight transcript 落盘 + 标题来源读取）。 */
  sessions: Pick<SessionPort, 'getMeta' | 'appendMessages' | 'updateMeta' | 'getMessages'>
  /** 终态消息载荷（旧 `onComplete(messages, opts)` 第一参语义）。 */
  messages(sessionId: string): AgentMessage[]
  onIdle?(sessionId: string): void
  /** 计划模式事件出口（host port 的 host_event → profer_event）。 */
  emitPlanModeEvent(sessionId: string, event: AgentRuntimePlanModeEvent): void
  /** 审批通过后同步 provider 侧权限模式。 */
  setProviderPermissionMode?(sessionId: string, mode: ProferPermissionMode): void
  /**
   * GAP-D1：自动命名窗口的宿主事实（生成器 + 标题更新投影 + 两个常量）。
   *
   * 判据与编排在 `agent-session-title-naming.ts`（与旧链同一实现），本模块只透传：
   * 桌面链的投影由 `agent-service.ts` 按旧链 `runAgent.onTitleUpdated` 逐字提供
   * （`profer_event: title_updated` + `TITLE_UPDATED` 到已登记的 webContents）。
   */
  titleNaming?: RuntimeEntryTitleNaming
}

/** 桌面发起者推断：与旧链 `resolveInputInitiator(input, undefined)` 逐字同义。 */
export function resolveDesktopRunInitiator(input: AgentSendInput): AgentRunInitiator {
  return input.initiator ?? resolveRunInitiator(input.triggeredBy, undefined)
}

/**
 * 终态字段 → `STREAM_COMPLETE` 载荷。
 *
 * 与旧链 `runAgent.onComplete` 构造的 `completion` **同一字段集**：包含「值为 `undefined` 也保留键」，
 * 因此经 IPC 结构化克隆后 renderer 收到的对象与旧链逐键相同。
 */
function buildDesktopCompletion(
  sessionId: string,
  initiator: AgentRunInitiator,
  messages: AgentMessage[] | undefined,
  fields: RuntimeTerminalFields,
): AgentStreamCompletePayload {
  // 逐字段照抄旧链 `runAgent.onComplete` 构造的 completion：包括「值为 undefined 也保留键」，
  // 因为 IPC 走结构化克隆（保留 undefined 键），renderer 收到的对象才能与旧链逐键相同。
  return {
    sessionId,
    messages,
    ...(fields.runId ? { runId: fields.runId } : {}),
    ...(fields.eventId ? { eventId: fields.eventId } : {}),
    ...(fields.stopReason ? { stopReason: fields.stopReason } : {}),
    ...(fields.persistence ? { persistence: fields.persistence } : {}),
    ...(fields.messagesScope ? { messagesScope: fields.messagesScope } : {}),
    stoppedByUser: fields.stoppedByUser ?? false,
    startedAt: fields.startedAt,
    resultSubtype: fields.resultSubtype,
    resultErrors: fields.resultErrors,
    backgroundTasksPending: fields.backgroundTasksPending,
    endReason: fields.endReason,
    endReasonLabel: fields.endReasonLabel,
    initiator,
  }
}

/**
 * 运行一轮**桌面** runtime run。
 *
 * 被并发 / 内核不匹配拒绝时：`runRuntimeHeadlessEntry` 抛出具名错误且不投递任何终态，
 * 本函数原样向上抛 —— 调用方（IPC handler）让 `ipcRenderer.invoke` reject，
 * renderer 据此恢复发送前状态与用户草稿（与旧链一致）。
 */
export async function runDesktopRuntimeAgent(
  input: AgentSendInput,
  host: DesktopRuntimeAgentHost,
): Promise<void> {
  const sessionId = input.sessionId
  const initiator = resolveDesktopRunInitiator(input)

  host.registerWebContents(sessionId, host.sender)
  // 被 active-run 并发保护拒绝的请求不能清空已有 run 的恢复记录。
  if (!host.isExecutionActive(sessionId)) host.beginActiveStreamBacklog(sessionId)
  // 与旧链同位置、同语义：请求入口无条件清未读（helper 内部按模式短路 + 容错）。
  host.clearUnreadOnRequestEntry(sessionId)

  const deliverError = (error: string): void => {
    host.emit(sessionId, { kind: 'run_error', error })
    if (!host.sender.isDestroyed()) {
      host.sender.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId, error })
    }
  }
  /** 终态广播（未读已在此之前落盘）：`run_complete` + 专用 `STREAM_COMPLETE`。 */
  const broadcastComplete = (
    messages: AgentMessage[] | undefined,
    fields: RuntimeTerminalFields,
  ): void => {
    const completion = buildDesktopCompletion(sessionId, initiator, messages, fields)
    host.emit(sessionId, { kind: 'run_complete', completion })
    if (!host.sender.isDestroyed()) {
      host.sender.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, completion)
    }
  }
  const deliverCompletionUnread = (fields: RuntimeTerminalFields, started: boolean): void => {
    host.applyCompletionUnreadPolicy({
      sessionId,
      initiator,
      ...(fields.backgroundTasksPending !== undefined
        ? { backgroundTasksPending: fields.backgroundTasksPending }
        : {}),
      started,
    })
  }

  // 删除 / 分叉守卫：与旧链一样发生在任何 claim 之前，且走「错误 + 空终态」的用户可见语义
  // （不是并发拒绝 —— 并发拒绝必须抛具名错误让 renderer 恢复草稿）。
  const blocked = host.checkEntryGuards(sessionId)
  if (blocked !== undefined) {
    try {
      deliverError(blocked)
      const blockedFields: RuntimeTerminalFields = {
        stoppedByUser: false,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      }
      deliverCompletionUnread(blockedFields, false)
      broadcastComplete([], blockedFields)
    } finally {
      if (!host.isExecutionActive(sessionId)) host.finishActiveStreamBacklog(sessionId)
    }
    return
  }

  try {
    await runRuntimeHeadlessEntry(input, { onEvent: () => {} }, {
      initiator,
      ...(host.execution ? { execution: host.execution } : {}),
      resolveRunContext: sendInput => host.resolveRunContext(sendInput),
      run: (query, callbacks) => host.run(query, callbacks),
      sessions: host.sessions,
      messages: session => host.messages(session),
      ...(host.onIdle ? { onIdle: host.onIdle } : {}),
      emitPlanModeEvent: (sid, event) => host.emitPlanModeEvent(sid, event),
      ...(host.setProviderPermissionMode
        ? { setProviderPermissionMode: host.setProviderPermissionMode }
        : {}),
      ...(host.titleNaming ? { titleNaming: host.titleNaming } : {}),
      onRunStarted: async (startedInput, _startedAt) => {
        // 用户自己发出新一轮：旧未读随新 run 失效（与旧链 `runAgent.onRunStarted` 同序）。
        host.applyRunStartUnreadPolicy(startedInput.sessionId, initiator)
        const promotion = host.promoteDraftSession(startedInput.sessionId)
        if (promotion.promoted && promotion.session) {
          await host.onDraftPromoted?.(promotion.session)
          host.publishSessionProjection(promotion.session)
        }
      },
      // `started` 由共享入口透传（从未真正启动的请求不得写未读），这里只把它接到宿主策略上。
      applyCompletionUnread: (_unreadInput, fields, started) => deliverCompletionUnread(fields, started),
      sink: {
        onError: error => deliverError(error),
        onComplete: (messages, fields) => broadcastComplete(messages, fields),
      },
    })
  } finally {
    if (!host.isExecutionActive(sessionId)) host.finishActiveStreamBacklog(sessionId)
  }
}
