/**
 * agent-runtime-terminal-projection — runtime 终态投影的唯一责任方
 *
 * 背景（来源：`runtime-parallel-2026-10-15/parity/failures.md` R4 与
 * `integration/reports/05-next-slice.md` C3）：
 * 新 runtime 入口 `runAgentRuntimeHeadless` 只把 `AgentRunOutcome`（仅 `status`）交给调用方，
 * 而 remote / automation 的**旧**分支直接从 `runAgentHeadless` 的 `onComplete(messages, opts)`
 * 透传 `startedAt / resultSubtype / resultErrors / backgroundTasksPending / endReason / endReasonLabel`。
 * 结果：同一次运行在两条入口下产生**字段集不同**的 `run_completed`，移动端中断 chip / toast 与
 * 未读口径会随入口漂移；同时 `onError` 由 coordinator 级和入口级各自触发，存在重复终态风险。
 *
 * 本模块把这件事收成一个纯投影 + 一个一次性闸门：
 * 1. `resolveRuntimeTerminalFields`：outcome（+ 本轮可观察轨迹）→ 规范终态字段集，
 *    与旧路径 `normalizeAgentEndReason` 同源，不新造第二套判据。
 * 2. `createRuntimeTerminalProjector`：一次 run 最多投递一次 `onError` + 一次 `onComplete`；
 *    迟到的 / 重复的 provider 终态信号被忽略，不再二次触发用户可见终态。
 * 3. `buildRunCompletedProjection`：终态字段 → `ProferEvent: run_completed` 的唯一映射，
 *    remote / automation / headless / host event port 共用同一份字段集。
 *
 * 边界：本模块**不**落盘、不发事件、不读会话、不碰 Electron；落盘与广播仍由宿主入口执行。
 * 错误气泡 / interruption_record 等产品语义留在宿主（见 `agent-runtime-preflight-projection.ts`），
 * 不下沉到 runtime core。
 */

import type { AgentRunOutcome } from '@profer/agent-runtime'
import type {
  AgentEndReason,
  AgentExternalRunSource,
  AgentMessage,
  ProferEvent,
  SDKMessage,
} from '@profer/shared'
import { normalizeAgentEndReason } from './agent-end-reason'
import type { HeadlessAgentCompletionOptions } from './agent-headless-runner-registry'

/**
 * 规范终态字段集。
 *
 * 直接复用 `HeadlessAgentCompletionOptions`，而不是另立一个同形接口：
 * headless callbacks 的 completion options 就是「用户可见终态」的既有定义，
 * 新入口若再定义一份，迟早会出现第三份字段集（这正是本模块要消除的问题）。
 */
export type RuntimeTerminalFields = HeadlessAgentCompletionOptions

/** `run_completed` 投影（ProferEvent 子集），remote / automation / host 共用。 */
export type RuntimeRunCompletedProjection = Extract<ProferEvent, { type: 'run_completed' }>

/** 一次 run 过程中可观察到的、`AgentRunOutcome` 不携带的终态事实。 */
export interface RuntimeRunObservation {
  /** `onRunStarted({ startedAt })` 的返回值；runtime core 生成的 run 起始时刻。 */
  startedAt?: number
  persistence?: import('@profer/agent-runtime').RuntimePersistenceState
  runId?: string
  /** provider 流中最后一个 `result` SDKMessage：outcome 丢掉的 subtype / errors 从这里恢复。 */
  resultMessage?: SDKMessage
  /** 后台任务信号（adapter 的 `idleComplete`）。它不是终态，仅影响未读与 UI 空闲态。 */
  backgroundTasksPending?: boolean
}

export interface ResolveRuntimeTerminalFieldsInput {
  outcome: AgentRunOutcome
  /** 运行来源只用于追溯，绝不用于推断停止原因。 */
  source?: AgentExternalRunSource
  observation?: RuntimeRunObservation
}

/** 从 `result` SDKMessage 提取 subtype / errors；与 runtime core stream 分支判据同义。 */
export function readResultSignal(result: SDKMessage | undefined): { subtype?: string; errors?: string[] } {
  if (!result) return {}
  const raw = result as unknown as { subtype?: unknown; errors?: unknown }
  const subtype = typeof raw.subtype === 'string' && raw.subtype.length > 0 ? raw.subtype : undefined
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  return {
    ...(subtype ? { subtype } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  }
}

/**
 * outcome → 规范终态字段。
 *
 * 结束原因（`endReason` / `endReasonLabel`）统一走既有 `normalizeAgentEndReason`，
 * 与旧编排器 owner-finally 的归一化完全同源；本模块不新增第二套判定。
 *
 * 判定口径（与旧路径对齐）：
 * - `stopped`：仅可信 stopReason 明确 parent_cancel / delegation_cancel 时投影为取消；
 *   单独停止 child 与启动来源无关，仍是用户中断。
 * - `failed`：`endReason: 'error'`、`endReasonLabel` 取归一化 label（旧路径为「执行出错」）；
 *   `resultErrors` 优先取 result 消息的 errors，没有则回落到 outcome.error（保证移动端一定有可读原因）。
 * - `completed`：只透传可观察字段；`endReason` 为 `completed`（旧 remote 分支会透传它，
 *   用于移动端清除旧的中断 chip）。
 */
export function resolveRuntimeTerminalFields(input: ResolveRuntimeTerminalFieldsInput): RuntimeTerminalFields {
  const { outcome } = input
  const observation = input.observation ?? {}
  const { subtype, errors } = readResultSignal(observation.resultMessage)
  const stopped = outcome.status === 'stopped'
  const delegationCancelled = stopped && (outcome.stopReason === 'parent_cancel' || outcome.stopReason === 'delegation_cancel')
  const hasError = outcome.status === 'failed'
  const stoppedByUser = stopped && !delegationCancelled
  const resultSubtype = subtype
  const normalizedSubtype = hasError && resultSubtype === 'success' ? undefined : resultSubtype
  const terminalReason = stopped
    ? normalizeAgentEndReason({ stoppedByUser, hasError, ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}) })
    : outcome.status === 'failed'
      ? normalizeAgentEndReason({ resultSubtype: normalizedSubtype, hasError: true })
      : { reason: 'completed' as const, label: '' }

  return {
    outcomeStatus: outcome.status,
    ...(outcome.status === 'stopped' && outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
    stoppedByUser,
    ...(observation.persistence ? { persistence: observation.persistence } : {}),
    ...(observation.runId ? { runId: observation.runId, eventId: `terminal:${observation.runId}` } : {}),
    ...(observation.startedAt !== undefined ? { startedAt: observation.startedAt } : {}),
    ...(resultSubtype !== undefined ? { resultSubtype } : {}),
    ...(hasError
      ? { resultErrors: normalizedSubtype && errors?.length ? errors : [outcome.error] }
      : errors && errors.length > 0
        ? { resultErrors: errors }
        : {}),
    ...(observation.backgroundTasksPending === true ? { backgroundTasksPending: true } : {}),
    endReason: terminalReason.reason,
    endReasonLabel: terminalReason.label,
  }
}

/**
 * 终态字段 → `run_completed` 事件载荷。
 *
 * 这是 remote / automation / headless / host event port 的**同一完成映射**：
 * 调用方不再各自挑字段（旧 remote 分支缺 `startedAt`/`resultSubtype`/`backgroundTasksPending`，
 * 新 host event port 只在失败时补 `resultErrors`，都是字段集漂移的现场）。
 */
export function buildRunCompletedProjection(
  sessionId: string,
  fields: RuntimeTerminalFields,
): RuntimeRunCompletedProjection {
  return {
    type: 'run_completed',
    sessionId,
    stoppedByUser: fields.stoppedByUser === true,
    ...(fields.runId ? { runId: fields.runId } : {}),
    ...(fields.eventId ? { eventId: fields.eventId } : {}),
    ...(fields.stopReason ? { stopReason: fields.stopReason } : {}),
    ...(fields.outcomeStatus ? { outcomeStatus: fields.outcomeStatus } : {}),
    ...(fields.startedAt !== undefined ? { startedAt: fields.startedAt } : {}),
    ...(fields.resultSubtype !== undefined ? { resultSubtype: fields.resultSubtype } : {}),
    ...(fields.resultErrors !== undefined ? { resultErrors: [...fields.resultErrors] } : {}),
    ...(fields.backgroundTasksPending !== undefined ? { backgroundTasksPending: fields.backgroundTasksPending } : {}),
    ...(fields.endReason !== undefined ? { endReason: fields.endReason as AgentEndReason } : {}),
    ...(fields.endReasonLabel !== undefined ? { endReasonLabel: fields.endReasonLabel } : {}),
  }
}

/** 终态投递目标：headless callbacks 的终态两兄弟（`onTitleUpdated` 与终态无关，不在此列）。 */
export interface RuntimeTerminalSink {
  onError(error: string): void
  onComplete(fields: RuntimeTerminalFields, messages?: AgentMessage[]): void
}

export interface RuntimeTerminalProjectorOptions {
  sink: RuntimeTerminalSink
  source?: AgentExternalRunSource
  /** 终态消息载荷（旧 `onComplete(messages, opts)` 第一参语义）；缺省不带消息。 */
  messages?: () => AgentMessage[] | undefined
}

export interface RuntimeTerminalSettlement {
  /** 本次 settle 是否真的投递了用户可见终态；重复/迟到 settle 返回 false。 */
  delivered: boolean
  fields?: RuntimeTerminalFields
  error?: string
}

/**
 * provider 轻量完成信号携带的字段。
 *
 * 注意：真终态**不含** `backgroundTasksPending`（与旧编排层一致：`idleComplete` 直达 `onComplete`，
 * 真终态走 `pendingTerminalCompletion`，不写 meta、不透传 endReason）。
 */
export interface RuntimeBackgroundTasksSignal {
  startedAt?: number
  resultSubtype?: string
  resultErrors?: readonly string[]
}

export interface RuntimeTerminalProjector {
  /** `onRunStarted({ startedAt })`。 */
  observeRunStarted(startedAt: number, runId?: string): void
  observeRunIdentity(runId: string): void
  observePersistence(state: import('@profer/agent-runtime').RuntimePersistenceState): void
  /** provider 流中的每条 SDKMessage；只保留最后一个 `result`。 */
  observeMessage(message: SDKMessage): void
  /** provider 报错。**不立即投递**：统一在 settle 时决定，避免重复触发。 */
  observeProviderError(error: unknown): void
  /**
   * 轻量完成（provider 的 `_keepChannelOpenForTasks` / 旧编排层 `idleComplete`）：
   * 投递 `backgroundTasksPending: true` 的 `run_completed`，但**不**结束 run、不标记 settled，
   * 也不把该标记带进真终态。已结算 / 已被拒绝时返回 `undefined`（不重复投递）。
   */
  settleBackgroundTasksPending(signal?: RuntimeBackgroundTasksSignal): RuntimeTerminalFields | undefined
  /** 唯一投递点。 */
  settle(outcome: AgentRunOutcome): RuntimeTerminalSettlement
  /** 请求从未取得 owner（并发拒绝 / 内核不匹配）：标记已结算但不投递任何终态。 */
  rejectBeforeStart(): void
  readonly settled: boolean
  /** 本轮已记录但尚未投递的 provider 错误文本（诊断用）。 */
  readonly pendingError: string | undefined
}

/**
 * 一次 run 的终态闸门。
 *
 * 不变量：
 * - `onError` 与 `onComplete` 各自**最多一次**；`onError` 必先于 `onComplete`（与旧路径
 *   `callbacks.onError(...)` → `callbacks.onComplete(...)` 顺序一致）。
 * - 终态之后的任何 `settle` / `observe*` 都不会再投递。
 * - `rejectBeforeStart()` 之后不投递，调用方应自行 reject（并发/内核不匹配语义仍由宿主抛出）。
 * - 只有最终 outcome 为 `failed` 时才投递 `onError`；`stopped` 即使期间出现过 provider 错误
 *   也不再报错（用户停止优先，与 `normalizeAgentEndReason` 的优先级一致）。
 */
export function createRuntimeTerminalProjector(
  options: RuntimeTerminalProjectorOptions,
): RuntimeTerminalProjector {
  const observation: RuntimeRunObservation = {}
  let providerError: string | undefined
  let settled = false
  let rejected = false

  return {
    observeRunStarted(startedAt, runId) {
      if (settled) return
      observation.startedAt = startedAt
      if (runId) observation.runId = runId
    },
    observeRunIdentity(runId) {
      if (!settled) observation.runId = runId
    },
    observePersistence(state) { observation.persistence = { ...state } },
    observeMessage(message) {
      if (settled) return
      if ((message as unknown as { type?: unknown }).type === 'result') {
        observation.resultMessage = message
      }
    },
    observeProviderError(error) {
      if (settled) return
      providerError ??= error instanceof Error ? error.message : String(error)
    },
    settleBackgroundTasksPending(signal = {}) {
      // 软空闲不是终态：不写 settled、不参与 outcome 判定，真终态随后另行投递。
      if (settled || rejected) return undefined
      const fields: RuntimeTerminalFields = {
        stoppedByUser: false,
        ...(signal.startedAt !== undefined ? { startedAt: signal.startedAt } : {}),
        ...(signal.resultSubtype !== undefined ? { resultSubtype: signal.resultSubtype } : {}),
        ...(signal.resultErrors !== undefined && signal.resultErrors.length > 0
          ? { resultErrors: [...signal.resultErrors] }
          : {}),
        backgroundTasksPending: true,
      }
      options.sink.onComplete(fields, options.messages?.())
      return fields
    },
    settle(outcome) {
      if (settled) return { delivered: false }
      settled = true
      if (rejected) return { delivered: false }

      const fields = resolveRuntimeTerminalFields({
        outcome,
        ...(options.source !== undefined ? { source: options.source } : {}),
        observation,
      })
      const error = outcome.status === 'failed' ? providerError ?? outcome.error : undefined
      if (error !== undefined) {
        try { options.sink.onError(error) } catch (notificationError) {
          console.warn('[Agent Runtime] 错误观察者异常，继续交付终态:', notificationError)
        }
      }
      options.sink.onComplete(fields, options.messages?.())
      return { delivered: true, fields, ...(error !== undefined ? { error } : {}) }
    },
    rejectBeforeStart() {
      settled = true
      rejected = true
    },
    get settled() {
      return settled
    },
    get pendingError() {
      return providerError
    },
  }
}
