import { createAgentRunContext } from '@profer/agent-runtime'
import { GoalController } from '@profer/agent-runtime/goal-controller'
import { buildGoalIterationPrompt, DEFAULT_GOAL_LIMITS } from '@profer/agent-runtime/goal-loop'
import type { AgentGoalContract, AgentGoalLimits, AgentGoalState, AgentGoalIterationResult, AgentGoalUsage } from '@profer/shared'
import type { AgentRuntimeRunHandle } from '@profer/agent-runtime'
import type { CoreAgentRuntime } from './runtime'
import { isGoalResumableByMessage, type SDKMessage, type AgentRunInitiator } from '@profer/shared'
import { buildGoalVisibleResult, goalResultKey, stableGoalUuid } from '@profer/agent-runtime/goal-projection'
import { assessGoalTurnProgress, collectGoalRunUsage } from '@profer/agent-runtime/goal-progress'
import { CoreGoalStore } from './goal-store'

/** Core宿主适配：调度、预算、生命周期沿用唯一GoalController，执行沿用Coordinator。 */
export class CoreGoalService {
  private runtime?: CoreAgentRuntime
  private readonly controller: GoalController
  private readonly runs = new Map<string, { sessionId: string; handle: AgentRuntimeRunHandle }>()
  constructor(private readonly store: CoreGoalStore) {
    this.controller = new GoalController({
      runTurn: input => this.runTurn(input),
      stopTurn: async (sessionId, runId) => {
        const run = runId ? this.runs.get(runId) : undefined
        if (run?.sessionId === sessionId) { await run.handle.stop(); await run.handle.promise }
      },
      onSchedulerError: error => { this.persistenceError ??= error; console.error('[Core Goal] 调度或持久化失败，已暂停：', error) },
      canRun: sessionId => !this.persistenceError && !this.runtime?.deletions.isDeleting(sessionId) && !this.runtime?.coordinator.isRunning(sessionId),
      waitingReason: sessionId => this.runtime?.permissions.getMode(sessionId) === 'plan' ? 'plan_mode' : undefined,
      onBeforeClear: state => this.store.archive(state),
      onStateChange: state => {
        // 先持久化，再发状态；写入异常阻止下一轮调度。
        if (this.disposed) return
        try {
          this.store.save(this.controller.list())
          this.project(state)
        }
        catch (error) { this.persistenceError = error; throw error }
        const latest = state.reasonCode === 'cleared' ? state : this.controller.get(state.sessionId) ?? state
        this.runtime?.publish({ type: 'runtime', sessionId: latest.sessionId, payload: { kind: 'profer_event', event: { type: 'goal_state', state: latest } } })
      },
    })
  }
  bindRuntime(runtime: CoreAgentRuntime): void {
    this.runtime = runtime
    this.controller.restore(this.store.load())
    this.store.save(this.controller.list())
    for (const state of this.controller.list()) this.project(state)
  }
  private readonly projecting = new Set<string>()
  private project(state: AgentGoalState): void {
    const runtime = this.runtime
    if (!runtime || this.projecting.has(state.id)) return
    this.projecting.add(state.id)
    try {
      if (runtime.deletions.isDeleting(state.sessionId)) return
      const message = buildGoalVisibleResult(state)
      if (message && !runtime.sessions.readMessages(state.sessionId).some(value => (value as { _goalResultKey?: string })._goalResultKey === goalResultKey(state))) {
        runtime.sessions.appendMessages(state.sessionId, [message])
        runtime.publish({ type: 'message', sessionId: state.sessionId, payload: { type: 'message', sessionId: state.sessionId, message } })
      }
      if (state.status === 'blocked') {
        const session = runtime.sessions.getMeta(state.sessionId)
        const id = state.blockedTodoId ?? stableGoalUuid(`goal-blocked:${state.id}`)
        const notes = `Goal：${state.goal}\n阻塞原因：${state.reasonDetail || state.stopReason || state.lastSummary || '需要输入'}\n处理后可回到会话继续。`
        const todo = runtime.planning.getTodo(id) ?? runtime.planning.createTodo({ title: `[Goal 受阻] ${state.goal.slice(0, 60)}`, notes, priority: 'high', workspaceId: session?.workspaceId, sessionId: state.sessionId }, id)
        if (todo.notes !== notes || todo.status !== 'open') runtime.planning.updateTodo({ id, status: 'open', notes, expectedUpdatedAt: todo.updatedAt })
        if (!state.blockedTodoId) this.controller.patch(state.sessionId, { blockedTodoId: id })
        runtime.publish({ type: 'planning', sessionId: '', payload: { type: 'changed', resources: ['todos'] } })
      } else if (state.blockedTodoId && ['active', 'completed', 'failed', 'stopped', 'budget_limited'].includes(state.status)) {
        const todo = runtime.planning.getTodo(state.blockedTodoId)
        if (todo && todo.status !== 'completed') {
          runtime.planning.updateTodo({ id: todo.id, status: 'completed', notes: state.status === 'active' ? 'Goal已恢复执行' : `Goal状态：${state.status}`, expectedUpdatedAt: todo.updatedAt })
          runtime.publish({ type: 'planning', sessionId: '', payload: { type: 'changed', resources: ['todos'] } })
        }
      }
    } finally { this.projecting.delete(state.id) }
  }
  async prepareUserTurn(sessionId: string): Promise<void> {
    const state = this.controller.get(sessionId)
    if (!state) return
    this.assertAvailable()
    if (['active', 'stopping'].includes(state.status)) await this.controller.pauseForInterrupt(sessionId)
  }
  async onRunFinished(sessionId: string, initiator?: AgentRunInitiator): Promise<void> {
    if (this.disposed || this.persistenceError || (initiator !== 'user' && initiator !== 'external')) return
    this.controller.noteUserActivity(sessionId)
    const state = this.controller.get(sessionId)
    if (state && !state.activeRunId && isGoalResumableByMessage(state)) await this.controller.resume(sessionId)
  }
  list(sessionId?: string): AgentGoalState[] { return this.controller.list().filter(goal => !sessionId || goal.sessionId === sessionId).map(goal => structuredClone(goal)) }
  get(goalId: string): AgentGoalState { const state = this.controller.list().find(goal => goal.id === goalId); if (!state) throw new Error('Goal不存在'); return state }
  async start(sessionId: string, goal: string, limits: AgentGoalLimits = DEFAULT_GOAL_LIMITS, contract?: AgentGoalContract): Promise<AgentGoalState> {
    if (this.persistenceError) throw new Error(`Core Goal持久化已失败：${String(this.persistenceError)}`)
    if (this.disposed) throw new Error('Core Goal服务已关闭')
    const session = this.runtime?.sessions.getMeta(sessionId)
    if (!session) throw new Error('Goal会话不存在')
    return this.controller.start(sessionId, goal, contract, Date.now(), limits)
  }
  pause(goalId: string): Promise<AgentGoalState> { return this.controller.pause(this.get(goalId).sessionId) }
  stop(goalId: string): Promise<AgentGoalState> { return this.controller.stop(this.get(goalId).sessionId) }
  resume(goalId: string): Promise<AgentGoalState> { this.assertAvailable(); return this.controller.resume(this.get(goalId).sessionId) }
  update(goalId: string, patch: Parameters<GoalController['update']>[1]): AgentGoalState { this.assertAvailable(); return this.controller.update(this.get(goalId).sessionId, patch) }
  clear(goalId: string): void { this.controller.clear(this.get(goalId).sessionId) }
  history(sessionId?: string): AgentGoalState[] { return this.store.history(sessionId) }
  pauseSessionForInterrupt(sessionId: string): Promise<AgentGoalState> | undefined {
    const state = this.controller.get(sessionId)
    return state && ['active', 'stopping'].includes(state.status) ? this.controller.pauseForInterrupt(sessionId) : undefined
  }
  nudge(sessionId: string): void { if (!this.disposed && !this.persistenceError) this.controller.nudge(sessionId) }
  private assertAvailable(): void {
    if (this.disposed) throw new Error('Core Goal服务已关闭')
    if (this.persistenceError) throw new Error(`Core Goal持久化失败，请修复存储后重启：${String(this.persistenceError)}`)
  }
  private persistenceError?: unknown
  private disposed = false
  async shutdown(): Promise<void> {
    this.dispose()
    const results = await Promise.allSettled([...this.runs.values()].map(async run => { await run.handle.stop(); await run.handle.promise }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  dispose(): void { if (this.disposed) return; this.controller.stopAll(); this.disposed = true }
  private async runTurn(input: { sessionId: string; runId: string; state: AgentGoalState; previousSummary?: string; idleCheckin?: boolean }): Promise<AgentGoalIterationResult> {
    const runtime = this.runtime
    const session = runtime?.sessions.getMeta(input.sessionId)
    if (!runtime || !session) return { status: 'continue', summary: 'Goal会话不存在', evidence: [], outcome: 'failed', error: 'Goal会话不存在', errorKind: 'fatal' }
    let report: AgentGoalIterationResult | undefined
    let usage: AgentGoalUsage | undefined
    const messages: SDKMessage[] = []
    const base = runtime.createQuery(session, buildGoalIterationPrompt(input.state, { previousSummary: input.previousSummary, idleCheckin: input.idleCheckin }))
    const handle = runtime.coordinator.run({ ...base, runId: input.runId, taskId: input.state.id,
      persistedUserMessage: undefined, initiator: 'goal',
      context: createAgentRunContext({ sessionId: input.sessionId, initiator: 'goal', taskId: input.state.id, triggerId: `goal:${input.state.id}:${input.runId}` }, () => crypto.randomUUID()),
      goalRunId: input.state.id, goalIteration: input.state.iteration,
      onGoalResult: value => {
        const current = this.controller.get(input.sessionId)
        if (current?.id !== input.state.id || current.activeRunId !== input.runId || current.status !== 'active' || report) throw new Error('Goal报告过期、重复或不属于当前Run')
        report = this.store.report(input.state.id, input.runId, value)
      },
    }, { onEvent() {}, onMessage: message => {
      messages.push(message)
      usage = collectGoalRunUsage(messages)
    } })
    this.runs.set(input.runId, { sessionId: input.sessionId, handle })
    try {
      const outcome = await handle.promise
      if (outcome.status === 'failed') return { status: 'continue', summary: outcome.error, evidence: [], outcome: 'failed', error: outcome.error, errorKind: 'fatal', usage }
      if (outcome.status === 'stopped') return { status: 'continue', summary: '运行已停止', evidence: [], outcome: 'stopped', usage }
      if (report) return { ...report, usage }
      const progress = assessGoalTurnProgress(messages)
      return progress === 'progress'
        ? { status: 'continue', summary: '本轮有真实输出或工具进展，但没有结构化完成报告；继续执行', evidence: [], outcome: 'success', usage }
        : { status: 'continue', summary: progress === 'all_tools_failed' ? '本轮工具全部失败' : '本轮没有可确认进展', evidence: [], outcome: 'failed', usage }
    } finally { this.runs.delete(input.runId) }
  }
}
