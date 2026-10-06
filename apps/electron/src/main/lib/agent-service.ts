/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { join, dirname, basename, sep } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE, resolveRunInitiator } from '@profer/shared'
import type {
  AgentSendInput,
  AgentMessage,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  AgentRunInitiator,
  ProferPermissionMode,
  AgentExternalRunSource,
} from '@profer/shared'
import { ClaudeAgentAdapter, scanAndKillOrphanedClaudeSubprocesses } from './adapters/claude-agent-adapter'
import { PiAgentAdapter } from './adapters/pi-agent-adapter'
import { RuntimeRoutingAgentAdapter } from './adapters/runtime-routing-agent-adapter'
import { AgentEventBus } from './agent-event-bus'
import { fanoutSessionEvent } from './agent-event-fanout'
import { AgentCatalogInvalidationPublisher } from './agent-catalog-invalidation'
import { AgentOrchestrator, serializeErrorDetail } from './agent-orchestrator'
import { AgentRunAlreadyActiveError } from './agent-orchestrator-p0-guards'
import { createAgentRunOutcomeReporter } from './agent-run-outcome'
import { forwardHeadlessAgentCompletion, setHeadlessAgentRunner, type HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { getAgentSessionWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { getAgentSessionMeta, setAgentSessionActiveChecker, updateAgentSessionMeta } from './agent-session-manager'
import {
  configureAgentSessionProjectionPublisher,
  publishAgentSessionProjection,
  setAgentSessionUnread,
} from './agent-session-ui-projection-publisher'
import { shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion } from './agent-unread-policy'
import { getAgentUnreadPolicyMode } from './agent-unread-mode'
import { AgentRuntimeContextStore } from './agent-runtime-context'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()

/** 订阅任意会话的运行结束（含桌面与 headless 入口），回传本轮发起者。返回取消函数。 */
export function onAgentRunComplete(listener: (sessionId: string, initiator: AgentRunInitiator | undefined) => void): () => void {
  return eventBus.on((sessionId, payload) => {
    if (payload.kind === 'run_complete') listener(sessionId, payload.completion.initiator)
  })
}
configureAgentSessionProjectionPublisher(eventBus)
// 目录失效发布器单例：ipc.ts / remote-service.ts / workspace-watcher.ts 共享同一 revision 序列，
// 保证 Pocket 按 (catalog, workspaceSlug) 去重时看到的 revision 单调可信。
export const agentCatalogInvalidationPublisher = new AgentCatalogInvalidationPublisher(eventBus)
const claudeAdapter = new ClaudeAgentAdapter()
const piAdapter = new PiAgentAdapter()
// Both runtimes remain behind the same orchestrator, credential gate, P0 lifecycle and Plan-mode boundary.
const adapter = new RuntimeRoutingAgentAdapter({ claude: claudeAdapter, pi: piAdapter })
const orchestrator = new AgentOrchestrator(adapter, eventBus)
setAgentSessionActiveChecker((sessionId) => orchestrator.isActive(sessionId))
const runtimeContextStore = new AgentRuntimeContextStore()

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

/**
 * 返回当前活跃会话的运行时上下文窗口快照，供 Pocket 在首次连接/重连时水合。
 * 该数据不持久化，run_idle 到达后会立刻清除，避免向历史会话注入旧窗口。
 */
export function listActiveAgentRuntimeContexts(sessionIds?: readonly string[]) {
  return runtimeContextStore.list(sessionIds)
}

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()

/**
 * 当前活跃 run 的可回放事件。renderer 刷新会丢掉 Jotai 内存，但 main 中的
 * orchestrator 仍在运行；保存本轮已发出的事件可让新 renderer 重建相同 UI 状态。
 * 最终历史仍由 session JSONL 保存，故这里只保留 active run，结束立即释放。
 */
const activeStreamEventBacklogs = new Map<string, AgentStreamPayload[]>()
/** 已结束但尚未被刷新 Renderer 消费的终态快照，短暂保留以覆盖刷新竞态。 */
const completedStreamEventBacklogs = new Map<string, AgentStreamPayload[]>()
const COMPLETED_BACKLOG_TTL_MS = 60_000

function preserveCompletedBacklog(sessionId: string): void {
  const backlog = activeStreamEventBacklogs.get(sessionId)
  if (!backlog?.some((payload) => payload.kind === 'run_complete')) return
  completedStreamEventBacklogs.set(sessionId, backlog)
  // unref：只是过期清理，不应在进程退出前锁住事件循环。
  setTimeout(() => {
    if (completedStreamEventBacklogs.get(sessionId) === backlog) completedStreamEventBacklogs.delete(sessionId)
  }, COMPLETED_BACKLOG_TTL_MS).unref?.()
}

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
export function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 webContents 时直接覆盖；旧 wc 的 destroyed 钩子仍由 WeakSet 持有，
  // 触发时会扫描 sessionWebContents 清理所有指向旧 wc 的条目（见下方实现）。
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc === wc) sessionWebContents.delete(sid)
    }
  })
}

/**
 * 从 session → webContents 映射中移除指定会话。
 * 用于子会话 headless runner 完成后的清理，避免映射残留。
 */
export function unregisterWebContents(sessionId: string): void {
  sessionWebContents.delete(sessionId)
}

/**
 * renderer 刷新后的重连入口：先把当前 webContents 绑定为活跃 run 的接收方，
 * 再同步回放本轮事件。调用方必须先安装 STREAM_EVENT listener，避免回放丢失。
 */
export function restoreActiveAgentStreams(webContents: WebContents): string[] {
  const restored: string[] = []
  const snapshots = new Map([...completedStreamEventBacklogs, ...activeStreamEventBacklogs])
  for (const [sessionId, backlog] of snapshots) {
    if (!orchestrator.isActive(sessionId) && !completedStreamEventBacklogs.has(sessionId)) continue
    registerWebContents(sessionId, webContents)
    if (orchestrator.isActive(sessionId)) restored.push(sessionId)
    for (const payload of backlog) {
      if (webContents.isDestroyed()) break
      webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
      // 终态也走 backlog，但 renderer 仍有独立完成/错误 IPC 兼容入口；刷新恢复时补发它。
      if (payload.kind === 'run_complete') {
        webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, payload.completion)
      } else if (payload.kind === 'run_error') {
        webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId, error: payload.error })
      }
    }
    if (!orchestrator.isActive(sessionId)) completedStreamEventBacklogs.delete(sessionId)
  }
  return restored
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
}

export function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

// ===== EventBus IPC 转发中间件 =====

// 运行时上下文窗口是会话级状态，不应只依赖 Pocket 恰好在线时收到的瞬时事件。
// 在事件总线统一记录，覆盖桌面、远程、headless、Claude 与 Pi 的全部 Agent 入口。
eventBus.use((sessionId, payload, next) => {
  if (payload.kind === 'profer_event') {
    if (payload.event.type === 'context_window') {
      runtimeContextStore.setContextWindow(sessionId, payload.event.contextWindow)
    } else if (payload.event.type === 'run_idle') {
      runtimeContextStore.clear(sessionId)
    }
  }
  next()
})

// 必须先于 IPC 转发记录，确保刷新重连时能按原顺序回放所有已发生的实时事件。
eventBus.use((sessionId, payload, next) => {
  if (payload.kind !== 'session_projection' && payload.kind !== 'catalog_invalidation') {
    const backlog = activeStreamEventBacklogs.get(sessionId)
    if (backlog) backlog.push(payload)
  }
  next()
})

eventBus.use((sessionId, payload, next) => {
  const targets = payload.kind === 'session_projection' || payload.kind === 'catalog_invalidation'
    ? BrowserWindow.getAllWindows().map((window) => window.webContents)
    : [sessionWebContents.get(sessionId)]
  for (const wc of targets) {
    if (!wc || wc.isDestroyed()) continue
    try {
      wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  next()
})

// ===== 统一事件出口 =====

/**
 * 把一个会话实时事件扇出到「事件总线 + 必要的兜底直发」。
 *
 * 事件总线侧负责：remote-service 广播给所有 Pocket 客户端、写入 WS 事件重放日志，
 * 以及 EventBus IPC 中间件对该 session 已绑定 webContents 的转发。
 *
 * 因此当发起方就是已绑定的 webContents 时，中间件已经送达，这里不再直发 —— 否则
 * 同一窗口的渲染层会收到两份同事件。只有在未绑定（如窗口关闭后重开，该 session 不在
 * restoreActiveAgentStreams 的快照里，因而不会被重新绑定）、绑定已销毁或绑定不是
 * 发起方时，才补一次直发，避免横幅不消失。
 *
 * sessionId 为空表示 request 已过期，整件事都不做。
 */
export function emitSessionStreamEvent(
  sessionId: string | undefined | null,
  payload: AgentStreamPayload,
  fallbackSender?: WebContents | null,
): void {
  fanoutSessionEvent(
    {
      // 模块内使用本地实例名 eventBus，对外通过 `export { eventBus as agentEventBus }` 暴露。
      emitToBus: (sid, p) => eventBus.emit(sid, p as AgentStreamPayload),
      getBoundSender: (sid) => sessionWebContents.get(sid),
      sendToSender: (sender, sid, p) => {
        try {
          (sender as WebContents).send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId: sid,
            payload: p,
          } as AgentStreamEvent)
        } catch (err) {
          console.error(
            `[EventBus] 兜底 send 失败: sessionId=${sid}, payload.kind=${(p as Record<string, unknown>)?.kind}`,
            err,
          )
        }
      },
    },
    sessionId,
    payload,
    fallbackSender,
  )
}

// ===== IPC 薄包装函数 =====

/** 解析一轮 run 的规范化发起者：显式 initiator 优先，否则按 triggeredBy / headless source 推断。 */
function resolveInputInitiator(input: AgentSendInput, headlessSource: AgentExternalRunSource | undefined): AgentRunInitiator {
  return input.initiator ?? resolveRunInitiator(input.triggeredBy, headlessSource)
}

/**
 * 关闭态（`auto`）下「开始新一轮执行时清除完成未确认标记」——**原实现的位置与原语义**。
 *
 * 基线实现把它放在 `runAgent()` 最开头、`orchestrator.sendMessage` 之前，无条件执行并容忍任何写入失败；
 * 也就是说：即使请求随后被并发守卫拒绝、遇删除/分叉守卫或 preflight 失败，也会顺带清掉持久化未读。
 * 为保证「不开开关的人行为零变化」，关闭态必须保持这一点（开启态改由 `onRunStarted` 按发起者判定）。
 *
 * 与原实现的两点细微差别（均不影响可观测行为）：① 写走唯一写入口 `setAgentSessionUnread`
 * （会话不存在时返回 null 而不是抛错）；② 该写入口会同步广播一次 `session_projection`。
 */
function clearSessionUnreadOnRequestEntry(sessionId: string): void {
  try {
    if (getAgentUnreadPolicyMode() !== 'auto') return
    setAgentSessionUnread(sessionId, false)
  } catch { /* 与原 M1 的 try/catch 容错一致：新会话可能尚未写入索引 / 设置尚未加载 */ }
}

/**
 * run 真正进入运行（`onRunStarted`）时按模式清未读。
 *
 * **只在开启态生效**：关闭态的清未读已经在 `runAgent()` 入口按原位置（原 M1）做过，这里再写
 * 一次只会多出一次无意义的写盘与广播；headless 在基线里本就没有这一步，保持不新增。
 * 开启态下只有用户自己发起的运行才清（Pocket `send_message` 的 `initiator === 'user'` 也算用户发起）。
 */
function applyRunStartUnreadPolicy(sessionId: string, initiator: AgentRunInitiator): void {
  const mode = getAgentUnreadPolicyMode()
  if (mode === 'auto') return
  if (!shouldClearSessionUnreadOnRunStart(initiator, mode)) return
  try {
    setAgentSessionUnread(sessionId, false)
  } catch (error) {
    // 与既有实现一致：未读写入失败不得影响本轮 run（原 M1 的无条件写同样被 try/catch 包围）。
    console.error(`[Agent 服务] 清除会话未读失败: sessionId=${sessionId}`, error)
  }
}

/**
 * 一轮 run 到达终态（完成 / 失败 / 用户停止）时按模式写入未读。
 *
 * 关闭态下恒不写（完成类未读由渲染层 presence 判定写入内存集合）；开启态下子会话、
 * 后台续轮、从未启动的请求都不写。会话若已删除，`setAgentSessionUnread` 幂等返回 null。
 */
function applyCompletionUnreadPolicy(input: {
  sessionId: string
  initiator: AgentRunInitiator
  backgroundTasksPending?: boolean
  started?: boolean
}): void {
  const mode = getAgentUnreadPolicyMode()
  if (!shouldMarkSessionUnreadOnCompletion({
    initiator: input.initiator,
    delegationDepth: getAgentSessionMeta(input.sessionId)?.delegationDepth,
    backgroundTasksPending: input.backgroundTasksPending,
    started: input.started,
  }, mode)) return
  try {
    setAgentSessionUnread(input.sessionId, true)
  } catch (error) {
    // 未读只是 UI 状态：写入失败不得影响终态广播与用户可见的完成流程。
    console.error(`[Agent 服务] 写入会话未读失败: sessionId=${input.sessionId}`, error)
  }
}

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
  onDraftPromoted?: (session: import('@profer/shared').AgentSessionMeta) => void | Promise<void>,
): Promise<void> {
  // 更新 webContents 映射（允许覆盖 — 由 orchestrator.activeSessions 处理真正的并发保护）
  registerWebContents(input.sessionId, webContents)
  // 被 active-run 并发保护拒绝的请求不能清空已有 run 的恢复记录。
  if (!orchestrator.isActive(input.sessionId)) {
    activeStreamEventBacklogs.set(input.sessionId, [])
    completedStreamEventBacklogs.delete(input.sessionId)
  }
  // 本轮发起者：run 内不变。未显式给 initiator 时按 triggeredBy 推断（桌面 IPC 发送缺省 = 用户）。
  const initiator = resolveInputInitiator(input, undefined)
  // 关闭态（默认）：与原实现逐点保真 —— 请求入口无条件清未读（早于并发守卫 / 删除 / 分叉 /
  // preflight 判定，因此这些「没真正启动」的请求同样清；helper 内部按模式短路 + try/catch）。
  clearSessionUnreadOnRequestEntry(input.sessionId)
  const outcomeReporter = createAgentRunOutcomeReporter(input.onRunOutcome)
  let runStarted = false
  try {
    await orchestrator.sendMessage(input, {
      onRunOwned: () => { runStarted = true },
      onError: (error) => {
        outcomeReporter.onError(error)
        eventBus.emit(input.sessionId, { kind: 'run_error', error })
        const wc = sessionWebContents.get(input.sessionId)
        if (wc && !wc.isDestroyed()) wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: input.sessionId, error })
      },
      onComplete: (messages, opts) => {
        outcomeReporter.onComplete(opts)
        const completion = {
          sessionId: input.sessionId,
          messages,
          stoppedByUser: opts?.stoppedByUser ?? false,
          startedAt: opts?.startedAt,
          resultSubtype: opts?.resultSubtype,
          resultErrors: opts?.resultErrors,
          backgroundTasksPending: opts?.backgroundTasksPending,
          endReason: opts?.endReason,
          endReasonLabel: opts?.endReasonLabel,
          initiator,
        }
        // 未读先于终态广播落盘：渲染层收到 STREAM_COMPLETE 时侧边栏绿标与角标已经就绪。
        // `started` 必须透传：经 `onComplete` 收敛但从未真正启动的请求（删除/分叉守卫、
        // preflight 失败）在开启态不得写未读（`design.md` §5.4）。
        applyCompletionUnreadPolicy({
          sessionId: input.sessionId,
          initiator,
          backgroundTasksPending: opts?.backgroundTasksPending,
          started: runStarted,
        })
        eventBus.emit(input.sessionId, { kind: 'run_complete', completion })
        const wc = sessionWebContents.get(input.sessionId)
        if (wc && !wc.isDestroyed()) wc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, completion)
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'profer_event',
          event: { type: 'title_updated', title },
        })
        const currentWc = sessionWebContents.get(input.sessionId)
        if (currentWc && !currentWc.isDestroyed()) {
          currentWc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
      onRunStarted: async ({ startedAt }) => {
        runStarted = true
        // 用户自己发出新一轮：旧未读随新 run 失效（非用户发起的运行不清，见 agent-unread-policy）。
        applyRunStartUnreadPolicy(input.sessionId, initiator)
        const beforePromotion = getAgentSessionMeta(input.sessionId)
        const session = beforePromotion?.draft
          ? updateAgentSessionMeta(input.sessionId, { draft: false })
          : beforePromotion
        if (beforePromotion?.draft && session) {
          await onDraftPromoted?.(session)
          publishAgentSessionProjection(session)
        }
        if (input.triggeredBy === 'goal') {
          // 仅在真实 run 已启动后建立 UI 流状态，不把恢复/排队的 Goal 伪装为运行中。
          eventBus.emit(input.sessionId, {
            kind: 'profer_event',
            event: { type: 'external_run_started', source: 'goal', sessionId: input.sessionId, startedAt, title: session?.title, workspaceId: session?.workspaceId, modelId: input.modelId, session },
          })
        }
      },
    })
  } catch (err) {
    // 请求没有获得 run ownership：不要向同 session 的 owner run 广播假的错误/终态。
    // 让 ipcRenderer.invoke 直接 reject，renderer 会恢复发送前状态和用户草稿。
    if (err instanceof AgentRunAlreadyActiveError) {
      outcomeReporter.rejectBeforeStart()
      throw err
    }
    console.error(`[Agent 服务] ══════════ runAgent 未处理异常 ══════════`)
    console.error(`[Agent 服务] sessionId: ${input.sessionId}`)
    console.error(`[Agent 服务] raw error 详细诊断:\n${serializeErrorDetail(err)}`)
    console.error(`[Agent 服务] err instanceof Error: ${err instanceof Error}`)
    console.error(`[Agent 服务] typeof err: ${typeof err}`)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    outcomeReporter.onError(errorMessage)
    console.error(`[Agent 服务] errorMessage: ${errorMessage || '(空)'}`)
    console.error(`[Agent 服务] ══════════ runAgent 未处理异常 结束 ══════════`)
    // 已经在运行的一轮以异常结束：这一轮仍需用户确认（失败不自动已读）。
    // 从未真正启动的请求失败（runStarted === false）不算一轮，不产生未读。
    applyCompletionUnreadPolicy({ sessionId: input.sessionId, initiator, started: runStarted })
    eventBus.emit(input.sessionId, { kind: 'run_error', error: errorMessage })
    const completion = { sessionId: input.sessionId, messages: [], stoppedByUser: false, startedAt: input.startedAt, initiator }
    eventBus.emit(input.sessionId, { kind: 'run_complete', completion })
    const currentWc = sessionWebContents.get(input.sessionId)
    if (currentWc && !currentWc.isDestroyed()) {
      currentWc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: input.sessionId, error: errorMessage })
      currentWc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, completion)
    }
  } finally {
    // 仅在 orchestrator 已完成此会话时清理映射
    // 避免被拒绝的请求误删仍在运行的会话映射
    if (!orchestrator.isActive(input.sessionId)) {
      runtimeContextStore.clear(input.sessionId)
      sessionWebContents.delete(input.sessionId)
      preserveCompletedBacklog(input.sessionId)
      activeStreamEventBacklogs.delete(input.sessionId)
    }
    if (runStarted) outcomeReporter.finish()
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
): Promise<void> {
  // 尝试注册主窗口 webContents，让流式事件同步推送到桌面端
  const wc = getMainRendererWebContents()
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  // 本轮发起者：run 内不变。
  // fail-safe（design §2.3）：headless 运行没有显式 source 时按 'external' 处理（不清未读），
  // 绝不因为 triggeredBy 缺省而误判成用户发起。
  const initiator = runInput.initiator
    ?? (callbacks.source ? resolveRunInitiator(runInput.triggeredBy, callbacks.source) : 'external')
  let runStarted = false
  if (wc) {
    registerWebContents(runInput.sessionId, wc)
  }
  // 同理：外部入口的重复请求不得覆盖仍在运行的会话快照。
  if (!orchestrator.isActive(runInput.sessionId)) {
    activeStreamEventBacklogs.set(runInput.sessionId, [])
    completedStreamEventBacklogs.delete(runInput.sessionId)
  }

  try {
    await orchestrator.sendMessage(runInput, {
      onError: (error) => {
        callbacks.onError(error)
        eventBus.emit(runInput.sessionId, { kind: 'run_error', error })
        const currentWc = sessionWebContents.get(runInput.sessionId)
        if (currentWc && !currentWc.isDestroyed()) {
          currentWc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error })
        }
      },
      onComplete: (messages, opts) => {
        forwardHeadlessAgentCompletion({
          callbacks,
          messages,
          opts,
          forwardToRenderer: (completionMessages, completionOpts) => {
            const completion = {
              sessionId: runInput.sessionId,
              messages: completionMessages,
              stoppedByUser: completionOpts?.stoppedByUser ?? false,
              startedAt: completionOpts?.startedAt,
              resultSubtype: completionOpts?.resultSubtype,
              resultErrors: completionOpts?.resultErrors,
              backgroundTasksPending: completionOpts?.backgroundTasksPending,
              endReason: completionOpts?.endReason,
              endReasonLabel: completionOpts?.endReasonLabel,
              initiator,
            }
            applyCompletionUnreadPolicy({
              sessionId: runInput.sessionId,
              initiator,
              backgroundTasksPending: completionOpts?.backgroundTasksPending,
              started: runStarted,
            })
            eventBus.emit(runInput.sessionId, { kind: 'run_complete', completion })
            const currentWc = sessionWebContents.get(runInput.sessionId)
            if (currentWc && !currentWc.isDestroyed()) {
              currentWc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, completion)
            }
          },
        })
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'profer_event',
          event: { type: 'title_updated', title },
        })
        // 同步到渲染进程
        const currentWc = sessionWebContents.get(runInput.sessionId)
        if (currentWc && !currentWc.isDestroyed()) {
          currentWc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt }) => {
        runStarted = true
        // 用户自己发出新一轮（Pocket send_message）清未读；定时自动化 / 外部 IM / 委派子会话不清。
        applyRunStartUnreadPolicy(runInput.sessionId, initiator)
        // draft 晋升（与 runAgent.onRunStarted 对齐）：对话真正开始后草稿会话转为正式，
        // 否则 ensureProjectDraftAgentSession 永远复用旧草稿——
        // runAgentHeadless 路径点击项目将不会像桌面那样产生新对话（“点击项目仍指向刚才的对话”）。
        const beforePromotion = getAgentSessionMeta(runInput.sessionId)
        const session = beforePromotion?.draft
          ? updateAgentSessionMeta(runInput.sessionId, { draft: false })
          : beforePromotion
        // 用当前登记的窗口发送，而不是 run 启动时捕获的 wc（刷新后旧窗口已销毁，事件会丢）。
        if (beforePromotion?.draft && session) publishAgentSessionProjection(session)
        eventBus.emit(runInput.sessionId, {
          kind: 'profer_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: runInput.workspaceId ?? session?.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
            session,
            initiator,
          },
        })
      },
    })
  } catch (err) {
    // 同一会话已有 owner run 时，本次 headless 请求从未启动；不得广播终态破坏它。
    if (err instanceof AgentRunAlreadyActiveError) throw err
    console.error(`[Agent 服务] ══════════ runAgentHeadless 未处理异常 ══════════`)
    console.error(`[Agent 服务] sessionId: ${runInput.sessionId}`)
    console.error(`[Agent 服务] raw error 详细诊断:\n${serializeErrorDetail(err)}`)
    console.error(`[Agent 服务] err instanceof Error: ${err instanceof Error}`)
    console.error(`[Agent 服务] typeof err: ${typeof err}`)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    console.error(`[Agent 服务] errorMessage: ${errorMessage || '(空)'}`)
    console.error(`[Agent 服务] ══════════ runAgentHeadless 未处理异常 结束 ══════════`)
    callbacks.onError(errorMessage)
    const completion = { stoppedByUser: false, startedAt, endReason: 'error' as const, endReasonLabel: '执行出错' }
    // 已在运行的一轮异常结束：仍需手动确认；从未启动的请求失败不产生未读。
    applyCompletionUnreadPolicy({ sessionId: runInput.sessionId, initiator, started: runStarted })
    callbacks.onComplete([], completion)
    eventBus.emit(runInput.sessionId, { kind: 'run_error', error: errorMessage })
    const terminal = { sessionId: runInput.sessionId, messages: [], initiator, ...completion }
    eventBus.emit(runInput.sessionId, { kind: 'run_complete', completion: terminal })
    const currentWc = sessionWebContents.get(runInput.sessionId)
    if (currentWc && !currentWc.isDestroyed()) {
      currentWc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error: errorMessage })
      currentWc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, terminal)
    }
  } finally {
    if (!orchestrator.isActive(runInput.sessionId)) {
      runtimeContextStore.clear(runInput.sessionId)
      sessionWebContents.delete(runInput.sessionId)
      preserveCompletedBacklog(runInput.sessionId)
      activeStreamEventBacklogs.delete(runInput.sessionId)
    }
  }
}

// headless run 的渲染进程 completion 必须与普通桌面 run 走同一 service 转发，
// 不能由协作层另行构造字段不完整的 STREAM_COMPLETE。
setHeadlessAgentRunner((input, callbacks) => runAgentHeadless(input, callbacks))

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 手动重新生成 Agent 会话标题（不受定稿锁定限制）。
 *
 * channelId/modelId 缺省时回退到会话元数据上的上次选择；两者都没有就无法生成，返回 null。
 */
export async function regenerateAgentTitle(
  sessionId: string,
  channelId?: string,
  modelId?: string,
): Promise<{ title: string; session: import('@profer/shared').AgentSessionMeta } | null> {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) return null
  const resolvedChannelId = channelId || meta.channelId
  const resolvedModelId = modelId || meta.modelId
  if (!resolvedChannelId || !resolvedModelId) {
    console.warn('[Agent 服务] 重新生成标题缺少可用渠道/模型:', { sessionId })
    return null
  }
  const title = await orchestrator.regenerateTitle(sessionId, resolvedChannelId, resolvedModelId)
  if (!title) return null
  const session = getAgentSessionMeta(sessionId)
  return session ? { title, session } : null
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string): void {
  orchestrator.stop(sessionId)
}

export function getAgentRuntimeCapabilities(runtime: import('@profer/shared').AgentRuntime): import('@profer/shared').AgentRuntimeCapabilities {
  return adapter.getRuntimeCapabilities(runtime)
}

export function getAgentTaskOutput(sessionId: string, taskId: string, options?: { block?: boolean; timeoutMs?: number }): Promise<import('@profer/shared').GetTaskOutputResult> {
  return adapter.getTaskOutput(sessionId, taskId, options)
}

export async function stopAgentTask(sessionId: string, taskId: string, type?: 'agent' | 'shell'): Promise<void> {
  // SDK 后台任务（包含 shell）必须由产生它的 runtime adapter 停止；Pi 没有
  // Claude Task API 等价物时由 adapter 明确拒绝。长期 Pi 服务进程继续使用
  // KILL_PROCESS 的 ownership registry + PID/startTime 双因子路径，避免把不同
  // 命名空间的 taskId 与服务记录 id 错配后误杀进程。
  await adapter.stopTask(sessionId, taskId, type)
}

/** 删除运行中会话前停止并等待其真实运行生命周期结束。 */
export async function stopAgentAndWait(sessionId: string): Promise<void> {
  await orchestrator.stopAndWait(sessionId)
}

/** 检查指定 session 是否由给定 Goal runId 持有运行锁。 */
export function isGoalRunActive(sessionId: string, runId?: string): boolean {
  return orchestrator.isGoalRunActive(sessionId, runId)
}

/** 请求停止指定 Goal owner 并等待其 owner finally 真正释放。 */
export async function stopGoalRunAndWait(sessionId: string, runId: string): Promise<void> {
  await orchestrator.stopGoalRunAndWait(sessionId, runId)
}

/** 标记/解除会话删除锁，覆盖 UI、队列和 headless 等所有编排入口。 */
export function beginAgentSessionDeletion(sessionId: string): void {
  orchestrator.beginDeletion(sessionId)
}

export function endAgentSessionDeletion(sessionId: string): void {
  orchestrator.endDeletion(sessionId)
}

/**
 * 快照回退 / 清空对话：截断到指定消息点，恢复文件 + 截断对话。
 *
 * `assistantMessageUuid` 省略时表示清空整个对话（重置到会话起点），
 * 用于首轮就失败、没有可保留锚点的场景。
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid?: string,
): Promise<import('@profer/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isActive(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  orchestrator.stopAll()
}

/**
 * 退出前最后兜底：扫描并强杀所有孤儿 claude-agent-sdk 子进程
 *
 * 必须在 stopAllAgents() 之后调用。针对 pidMap 未覆盖、dispose 漏杀等极端场景。
 * 同步执行，不 await，确保 before-quit 能在 Electron 超时前完成。
 */
export function killOrphanedClaudeSubprocesses(): void {
  scanAndKillOrphanedClaudeSubprocesses()
}

/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Profer 侧（canUseTool 动态读取）和 SDK 侧（query.setPermissionMode）。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: ProferPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
  )
}

// ===== 文件操作 =====

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入 session 的 cwd，供 Agent 通过 Read 工具读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    // 防御：文件名不能包含路径分隔符、.. 或为绝对路径，防止路径穿越
    const safeFilename = basename(file.filename)
    if (safeFilename !== file.filename || safeFilename === '..' || file.filename.includes(sep) || file.filename.includes('/')) {
      console.warn(`[Agent 服务] 文件名包含非法路径字符，已净化: ${file.filename} → ${safeFilename}`)
    }
    let targetPath = join(sessionDir, safeFilename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 保存文件到工作区文件目录
 *
 * 将 base64 编码的文件写入工作区 workspace-files/ 目录，所有会话均可访问。
 */
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    // 防御：文件名不能包含路径分隔符、.. 或为绝对路径，防止路径穿越
    const safeFilename = basename(file.filename)
    if (safeFilename !== file.filename || safeFilename === '..' || file.filename.includes(sep) || file.filename.includes('/')) {
      console.warn(`[Agent 服务] 工作区文件名包含非法路径字符，已净化: ${file.filename} → ${safeFilename}`)
    }
    let targetPath = join(wsFilesDir, safeFilename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = safeFilename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? safeFilename.slice(0, dotIdx) : safeFilename
      const ext = dotIdx > 0 ? safeFilename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    const buffer = typeof file.data === 'string'
      ? Buffer.from(file.data, 'base64')
      : Buffer.from(file.data)

    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 工作区文件超过 100MB 限制，跳过: ${file.filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(wsFilesDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
