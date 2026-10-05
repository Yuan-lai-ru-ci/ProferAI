import {
  createGoalState,
  DEFAULT_GOAL_LIMITS,
  evaluateGoalContinuation,
  goalBudgetReason,
  GOAL_HISTORY_LIMIT,
} from './goal-loop'
import { applyGoalLimitsPatch, applyGoalTransition, getGoalActions, isValidGoalLimits, normalizeGoalReason } from '@profer/shared'
import type { AgentGoalContract, AgentGoalIterationRecord, AgentGoalIterationResult, AgentGoalLimitsPatch, AgentGoalState } from '@profer/shared'

type TimerHandle = unknown

type GoalControllerDependencies = {
  runTurn: (input: {
    sessionId: string
    runId: string
    state: AgentGoalState
    previousSummary?: string
    runtimeSessionId?: string
    onRuntimeSessionId: (sdkSessionId: string, sessionFile?: string) => void
  }) => Promise<AgentGoalIterationResult>
  stopTurn: (sessionId: string, runId?: string) => Promise<void>
  onStateChange?: (state: AgentGoalState) => void
  /** 清除前持久归档失败时保留 live Goal。 */
  onBeforeClear?: (state: AgentGoalState) => void
  canRun?: (sessionId: string) => boolean
  /** Goal 仍 active 但需等待外部条件（如计划模式），等待期间不计轮次。 */
  waitingReason?: (sessionId: string) => AgentGoalState['waiting']
  random?: () => number
  now?: () => number
  schedule?: (callback: () => void, delay?: number) => TimerHandle
  cancelSchedule?: (handle: TimerHandle) => void
  setTimer?: (callback: () => void, delay: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  stopTimeoutMs?: number
}

type Runtime = {
  state: AgentGoalState
  schedule?: TimerHandle
  generation: number
  scheduleEpoch: number
  activeRun?: { runId: string; iteration: number; startedAt: number; baseElapsedMs: number }
  stopping: boolean
}

const RETRY_DELAY_MS = 250
/** 等待外部条件时的兜底轮询；正常由 nudge() 立即唤醒。 */
const WAITING_FALLBACK_POLL_MS = 30_000
/** 可重试错误的退避间隔（对齐 Claude Code：1 / 5 / 15 分钟，±20% 抖动）。 */
export const GOAL_ERROR_RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const

export class GoalController {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly revisions = new Map<string, number>()
  private readonly now: () => number
  private readonly schedule: (callback: () => void, delay?: number) => TimerHandle
  private readonly cancelSchedule: (handle: TimerHandle) => void
  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly stopTimeoutMs: number
  private readonly random: () => number

  constructor(private readonly deps: GoalControllerDependencies) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? ((callback, delay = 0) => setTimeout(callback, delay))
    this.cancelSchedule = deps.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.stopTimeoutMs = deps.stopTimeoutMs ?? 5_000
    this.random = deps.random ?? Math.random
  }

  get(sessionId: string): AgentGoalState | undefined { return this.runtimes.get(sessionId)?.state }
  list(): AgentGoalState[] { return [...this.runtimes.values()].map((runtime) => runtime.state) }

  /** 整体 hydrate；恢复阶段不触发消息/Todo/渲染副作用。 */
  restore(states: AgentGoalState[]): void {
    if ([...this.runtimes.values()].some((runtime) => runtime.activeRun || runtime.state.status === 'active' || runtime.state.status === 'stopping')) throw new Error('运行中的 Goal 不能重新水合')
    const restored = new Map<string, Runtime>()
    for (const state of states) {
      if (restored.has(state.sessionId)) continue
      const isRunnable = state.status === 'active' || state.status === 'stopping'
      const nextState = isRunnable
        ? { ...applyGoalTransition(state, 'paused', { at: this.now(), reason: 'app_restart', detail: 'app_restart', runId: state.activeRunId }), activeRunId: undefined }
        : { ...state, activeRunId: undefined, revision: state.revision ?? 1, lifecycle: state.lifecycle ?? [] }
      delete nextState.retry
      delete nextState.waiting
      restored.set(state.sessionId, { state: nextState, generation: (state.revision ?? 0) + 1, scheduleEpoch: 0, stopping: false })
    }
    this.runtimes.clear()
    for (const [sessionId, runtime] of restored) {
      this.runtimes.set(sessionId, runtime)
      this.revisions.set(sessionId, Math.max(this.revisions.get(sessionId) ?? 0, runtime.state.revision ?? 0))
    }
  }

  async start(sessionId: string, goal: string, contract?: AgentGoalContract, now = this.now()): Promise<AgentGoalState> {
    const existing = this.runtimes.get(sessionId)
    if (existing?.activeRun) throw new Error('该会话已有正在运行的 Goal')
    if (existing && existing.state.status !== 'completed') throw new Error('该会话已有未完成的 Goal，请先恢复或清除它')
    if (existing) { this.cancelPending(existing); this.runtimes.delete(sessionId) }
    const runtime: Runtime = {
      state: createGoalState(sessionId, goal, now, { ...DEFAULT_GOAL_LIMITS }, contract, (this.revisions.get(sessionId) ?? 0) + 1),
      generation: (existing?.generation ?? 0) + 1,
      scheduleEpoch: 0,
      stopping: false,
    }
    this.runtimes.set(sessionId, runtime)
    this.emit(runtime.state)
    this.scheduleNext(sessionId, runtime, 0)
    return runtime.state
  }

  async pause(sessionId: string): Promise<AgentGoalState> {
    return this.requestStop(sessionId, 'paused', 'user_pause')
  }

  async stop(sessionId: string): Promise<AgentGoalState> {
    return this.requestStop(sessionId, 'stopped', 'user_stop')
  }

  /** 外部条件变化（如切换权限模式）时立即重新检查等待中的 Goal。 */
  nudge(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime || runtime.state.status !== 'active' || runtime.activeRun || runtime.stopping || !runtime.state.waiting) return
    this.cancelPending(runtime)
    this.scheduleNext(sessionId, runtime, 0)
  }

  /** 用户中断当前轮：只暂停，用户再发消息即可自动续上。 */
  async pauseForInterrupt(sessionId: string): Promise<AgentGoalState> {
    return this.requestStop(sessionId, 'paused', 'user_interrupt')
  }

  async resume(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    this.assertOwnerFree(runtime)
    const actions = getGoalActions(runtime.state)
    if (!actions.canResume && !actions.budgetEditRequired) throw new Error('只有暂停、阻塞、失败、停止或预算耗尽的 Goal 才能恢复')
    if (runtime.state.status === 'active' || runtime.state.status === 'stopping' || runtime.state.status === 'completed') throw new Error('当前 Goal 不能恢复')
    const budget = goalBudgetReason(runtime.state)
    if (budget) {
      this.transition(runtime, 'budget_limited', budget)
      throw new Error(`Goal 预算不足：${budget}`)
    }
    runtime.stopping = false
    runtime.generation++
    runtime.state = { ...runtime.state, consecutiveFailures: 0, retry: undefined }
    this.transition(runtime, 'active', undefined)
    this.scheduleNext(sessionId, runtime, 0)
    return runtime.state
  }

  /** 仅允许在没有 active owner 时修改目标、契约和预算。 */
  update(sessionId: string, patch: { goal?: string; contract?: AgentGoalContract; limits?: AgentGoalLimitsPatch }): AgentGoalState {
    const runtime = this.require(sessionId)
    this.assertOwnerFree(runtime)
    if (!getGoalActions(runtime.state).canEdit) throw new Error('运行中的 Goal 不能更新')
    const limits = patch.limits ? applyGoalLimitsPatch(runtime.state.limits, patch.limits) : runtime.state.limits
    if (!isValidGoalLimits(limits)) throw new Error('Goal 预算必须为有效正数；轮次与 token 必须为整数')
    if (patch.goal !== undefined && !patch.goal.trim()) throw new Error('Goal 不能为空')
    runtime.state = {
      ...runtime.state,
      goal: patch.goal?.trim() || runtime.state.goal,
      contract: patch.contract ?? runtime.state.contract,
      limits,
      revision: (runtime.state.revision ?? 0) + 1,
      updatedAt: this.now(),
    }
    this.emit(runtime.state)
    return runtime.state
  }

  patch(sessionId: string, patch: Partial<Pick<AgentGoalState, 'blockedTodoId'>>): AgentGoalState {
    const runtime = this.require(sessionId)
    this.assertOwnerFree(runtime)
    runtime.state = { ...runtime.state, ...patch, revision: (runtime.state.revision ?? 0) + 1, updatedAt: this.now() }
    this.emit(runtime.state)
    return runtime.state
  }

  clear(sessionId: string): AgentGoalState {
    const runtime = this.require(sessionId)
    this.assertOwnerFree(runtime)
    if (!getGoalActions(runtime.state).canClear) throw new Error('运行中的 Goal 不能直接清除')
    this.cancelPending(runtime)
    const cleared = applyGoalTransition(runtime.state, 'cleared', { at: this.now(), reason: 'cleared', detail: 'cleared' })
    this.deps.onBeforeClear?.(cleared)
    this.runtimes.delete(sessionId)
    this.emit(cleared)
    return cleared
  }

  stopAll(): void {
    for (const [sessionId, runtime] of this.runtimes) {
      if (runtime.state.status === 'active' || runtime.state.status === 'stopping') {
        runtime.stopping = true
        runtime.generation++
        this.cancelPending(runtime)
        this.transition(runtime, 'paused', 'app_restart')
        if (runtime.activeRun) void this.waitForStop(sessionId, runtime.activeRun.runId)
      }
    }
  }

  private async requestStop(sessionId: string, status: 'paused' | 'stopped' | 'budget_limited', reason: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    if (runtime.state.status === status) return runtime.state
    const actions = getGoalActions(runtime.state)
    if (status === 'paused' && !actions.canPause) throw new Error('当前 Goal 不能暂停')
    if (status === 'stopped' && !actions.canStop) throw new Error('当前 Goal 不能停止')
    const generation = ++runtime.generation
    runtime.stopping = true
    this.cancelPending(runtime)
    if (!runtime.activeRun) {
      this.transition(runtime, status, reason)
      return runtime.state
    }
    const runId = runtime.activeRun.runId
    this.transition(runtime, 'stopping', reason)
    await this.waitForStop(sessionId, runId)
    if (this.runtimes.get(sessionId) === runtime && runtime.generation === generation && runtime.state.status === 'stopping') this.transition(runtime, status, reason)
    return runtime.state
  }

  private async waitForStop(sessionId: string, runId: string): Promise<void> {
    let timer: TimerHandle | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => this.deps.stopTurn(sessionId, runId)).catch(() => undefined),
        new Promise<void>((resolve) => { timer = this.setTimer(resolve, this.stopTimeoutMs) }),
      ])
    } finally {
      if (timer !== undefined) this.clearTimer(timer)
    }
  }

  private scheduleNext(sessionId: string, runtime: Runtime, delay: number): void {
    const generation = runtime.generation
    const scheduleEpoch = ++runtime.scheduleEpoch
    runtime.schedule = this.schedule(() => {
      if (this.runtimes.get(sessionId) !== runtime || runtime.generation !== generation || runtime.scheduleEpoch !== scheduleEpoch) return
      runtime.schedule = undefined
      runtime.scheduleEpoch++
      void this.runTurn(sessionId, runtime, generation)
    }, delay)
  }

  private async runTurn(sessionId: string, runtime: Runtime, generation: number): Promise<void> {
    if (this.runtimes.get(sessionId) !== runtime || runtime.generation !== generation || runtime.stopping || runtime.activeRun || runtime.state.status !== 'active') return
    if (this.deps.canRun && !this.deps.canRun(sessionId)) { this.scheduleNext(sessionId, runtime, RETRY_DELAY_MS); return }
    const waiting = this.deps.waitingReason?.(sessionId)
    if (waiting !== runtime.state.waiting) {
      runtime.state = { ...runtime.state, waiting, revision: (runtime.state.revision ?? 0) + 1, updatedAt: this.now() }
      this.emit(runtime.state)
    }
    if (waiting) { this.scheduleNext(sessionId, runtime, WAITING_FALLBACK_POLL_MS); return }
    const budget = goalBudgetReason(runtime.state)
    if (budget) { this.transition(runtime, 'budget_limited', budget); return }
    const iteration = runtime.state.iteration + 1
    const runId = crypto.randomUUID()
    const turnStartedAt = this.now()
    runtime.activeRun = { runId, iteration, startedAt: turnStartedAt, baseElapsedMs: runtime.state.elapsedMs ?? 0 }
    runtime.state = { ...runtime.state, iteration, activeRunId: runId, revision: (runtime.state.revision ?? 0) + 1, updatedAt: turnStartedAt }
    this.emit(runtime.state)
    // 时长预算只在轮次边界检查，不在轮中砍断（对齐 Codex：到点收尾而不是中断）。
    try {
      const result = await this.deps.runTurn({
        sessionId,
        runId,
        state: runtime.state,
        previousSummary: runtime.state.lastSummary,
        // 仅保留旧调用方的兼容接口；同会话 Goal 不用此 ID 创建独立上下文。
        runtimeSessionId: runtime.state.runtimeSessionId,
        onRuntimeSessionId: (id, file) => {
          if (this.runtimes.get(sessionId) !== runtime || runtime.generation !== generation || runtime.activeRun?.runId !== runId || runtime.stopping || runtime.state.status !== 'active') return
          runtime.state = {
            ...runtime.state,
            runtimeSessionId: id,
            runtimeSessionFile: file,
            revision: (runtime.state.revision ?? 0) + 1,
            updatedAt: this.now(),
          }
          this.emit(runtime.state)
        },
      })
      await this.finishTurn(sessionId, runtime, generation, runId, iteration, turnStartedAt, result)
    } catch (error) {
      if (this.runtimes.get(sessionId) !== runtime || runtime.activeRun?.runId !== runId) return
      const message = error instanceof Error ? error.message : 'Goal 执行失败'
      await this.finishTurn(sessionId, runtime, generation, runId, iteration, turnStartedAt, { status: 'continue', outcome: 'failed', summary: message, evidence: [], error: message })
    }
  }

  private async finishTurn(sessionId: string, runtime: Runtime, generation: number, runId: string, iteration: number, turnStartedAt: number, result: AgentGoalIterationResult): Promise<void> {
    if (this.runtimes.get(sessionId) !== runtime || runtime.activeRun?.runId !== runId) return
    const finishedAt = this.now()
    const baseElapsedMs = runtime.activeRun.baseElapsedMs
    const elapsedMs = baseElapsedMs + Math.max(0, finishedAt - turnStartedAt)
    runtime.activeRun = undefined
    const previousStatus = runtime.state.status
    const usage = result.usage ? {
      inputTokens: (runtime.state.usage?.inputTokens ?? 0) + result.usage.inputTokens,
      outputTokens: (runtime.state.usage?.outputTokens ?? 0) + result.usage.outputTokens,
      totalTokens: (runtime.state.usage?.totalTokens ?? 0) + result.usage.totalTokens,
    } : runtime.state.usage
    if (runtime.generation !== generation || runtime.state.status === 'budget_limited' || runtime.stopping || previousStatus === 'stopped' || previousStatus === 'paused') {
      runtime.state = { ...runtime.state, activeRunId: undefined, elapsedMs, usage, revision: (runtime.state.revision ?? 0) + 1, updatedAt: finishedAt }
      runtime.stopping = false
      this.emit(runtime.state)
      return
    }
    if (result.outcome === 'failed' && result.errorKind) {
      this.handleRunError(sessionId, runtime, result, { iteration, elapsedMs, usage, finishedAt, runId })
      return
    }
    const decision = evaluateGoalContinuation(result, {
      iteration,
      consecutiveFailures: runtime.state.consecutiveFailures,
      startedAt: runtime.state.startedAt,
      now: finishedAt,
      elapsedMs,
      totalTokens: usage?.totalTokens,
      limits: runtime.state.limits,
      turnFailed: result.outcome === 'failed',
    })
    const nextStatus = decision.action === 'continue' || decision.action === 'deferred' ? 'active' : decision.action === 'complete' ? 'completed' : decision.action === 'blocked' ? 'blocked' : decision.action === 'failed' ? 'failed' : decision.action === 'stopped' ? 'stopped' : 'budget_limited'
    if (decision.action === 'deferred') {
      runtime.state = { ...runtime.state, activeRunId: undefined, iteration: iteration - 1, elapsedMs: baseElapsedMs, revision: (runtime.state.revision ?? 0) + 1, updatedAt: finishedAt }
      this.emit(runtime.state)
      if (!runtime.stopping) this.scheduleNext(sessionId, runtime, RETRY_DELAY_MS)
      return
    }
    const record: AgentGoalIterationRecord = {
      iteration,
      startedAt: turnStartedAt,
      finishedAt,
      status: result.status,
      outcome: result.outcome,
      error: result.error,
      summary: result.summary,
      evidence: result.evidence,
      usage: result.usage,
    }
    const detail = 'reason' in decision ? decision.reason : nextStatus === 'completed' ? result.summary : undefined
    const transitioned = applyGoalTransition(runtime.state, nextStatus, { at: finishedAt, detail, runId })
    runtime.state = {
      ...transitioned,
      activeRunId: undefined,
      elapsedMs,
      consecutiveFailures: decision.consecutiveFailures,
      history: [...(runtime.state.history ?? []), record].slice(-GOAL_HISTORY_LIMIT),
      usage,
      lastSummary: result.summary,
      lastEvidence: result.evidence,
      retry: undefined,
      revision: transitioned === runtime.state ? (runtime.state.revision ?? 0) + 1 : transitioned.revision,
      updatedAt: Math.max(finishedAt, transitioned.updatedAt),
    }
    this.emit(runtime.state)
    if (decision.action === 'continue' && !runtime.stopping) this.scheduleNext(sessionId, runtime, 0)
  }

  /** 运行级错误不计入无进展：可重试的按退避重排，用尽或不可恢复则暂停等用户处理。 */
  private handleRunError(sessionId: string, runtime: Runtime, result: AgentGoalIterationResult, turn: { iteration: number; elapsedMs: number; usage: AgentGoalState['usage']; finishedAt: number; runId: string }): void {
    // 出错的轮次不占用轮次预算，但已消耗的时间和 token 照常记账。
    runtime.state = { ...runtime.state, activeRunId: undefined, iteration: turn.iteration - 1, elapsedMs: turn.elapsedMs, usage: turn.usage }
    const error = result.error || result.summary
    const attempt = (runtime.state.retry?.attempt ?? 0) + 1
    const delay = GOAL_ERROR_RETRY_DELAYS_MS[attempt - 1]
    if (result.errorKind === 'retryable' && delay !== undefined) {
      const jittered = Math.round(delay * (0.8 + this.random() * 0.4))
      runtime.state = { ...runtime.state, retry: { attempt, nextAt: turn.finishedAt + jittered, error }, revision: (runtime.state.revision ?? 0) + 1, updatedAt: turn.finishedAt }
      this.emit(runtime.state)
      this.scheduleNext(sessionId, runtime, jittered)
      return
    }
    const reason = result.errorKind === 'retryable' ? 'retry_exhausted' : 'run_error'
    runtime.state = applyGoalTransition({ ...runtime.state, retry: undefined }, 'paused', { at: turn.finishedAt, reason, detail: error, runId: turn.runId })
    this.emit(runtime.state)
  }

  private assertOwnerFree(runtime: Runtime): void { if (runtime.activeRun) throw new Error('Goal runtime 仍在运行，等待其 owner 释放') }
  private transition(runtime: Runtime, status: AgentGoalState['status'], reason?: string): void {
    const elapsedMs = runtime.activeRun ? runtime.activeRun.baseElapsedMs + Math.max(0, this.now() - runtime.activeRun.startedAt) : runtime.state.elapsedMs
    const next = applyGoalTransition(runtime.state, status, { at: this.now(), reason: normalizeGoalReason(reason, status === 'active' ? 'resumed' : status === 'budget_limited' ? 'budget_limited' : 'unknown'), detail: reason, runId: runtime.activeRun?.runId })
    if (next === runtime.state) return
    runtime.state = { ...next, elapsedMs, ...(status === 'active' ? {} : { retry: undefined, waiting: undefined }) }
    this.emit(runtime.state)
  }
  private require(sessionId: string): Runtime {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) throw new Error('当前会话没有 Goal')
    return runtime
  }
  private cancelPending(runtime: Runtime): void {
    runtime.scheduleEpoch++
    if (runtime.schedule !== undefined) { this.cancelSchedule(runtime.schedule); runtime.schedule = undefined }
  }
  private emit(state: AgentGoalState): void {
    this.revisions.set(state.sessionId, state.revision ?? 0)
    this.deps.onStateChange?.(state)
  }
}
