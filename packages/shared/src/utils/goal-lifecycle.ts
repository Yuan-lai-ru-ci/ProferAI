import type { AgentGoalLifecycleEvent, AgentGoalLifecycleTarget, AgentGoalReasonCode, AgentGoalState, AgentGoalStatus } from '../types/agent'
import { getGoalBudgetExhaustedReasons } from './goal-contract'

export const GOAL_LIFECYCLE_LIMIT = 100
export const GOAL_STATUSES: readonly AgentGoalStatus[] = ['active', 'paused', 'completed', 'blocked', 'failed', 'stopped', 'stopping', 'budget_limited']
export const GOAL_REASON_CODES: readonly AgentGoalReasonCode[] = ['created', 'resumed', 'user_pause', 'user_stop', 'app_restart', 'blocked', 'failed', 'completed', 'budget_limited', 'cleared', 'superseded', 'user_interrupt', 'retry_exhausted', 'run_error', 'unknown']
const RESUMABLE: readonly AgentGoalStatus[] = ['paused', 'blocked', 'failed', 'stopped', 'budget_limited']

/** 状态层规则；owner 与预算由操作能力和 Controller 准入共同约束。 */
export function isGoalTransitionAllowed(from: AgentGoalStatus | null, to: AgentGoalLifecycleTarget): boolean {
  if (from === null) return to === 'active'
  if (to === 'cleared') return from !== 'active' && from !== 'stopping'
  if (from === to) return false
  if (from === 'active') return to !== 'active'
  if (from === 'stopping') return ['paused', 'stopped', 'budget_limited'].includes(to)
  if (from === 'completed') return false
  if (to === 'active' || to === 'budget_limited') return RESUMABLE.includes(from)
  // 已停下的目标仍可显式暂停/停止；操作能力限定实际入口。
  return to === 'paused' || to === 'stopped'
}

export function getGoalActions(goal: AgentGoalState) {
  const ownerBusy = Boolean(goal.activeRunId)
  const running = goal.status === 'active' || goal.status === 'stopping' || ownerBusy
  const budgetEditRequired = getGoalBudgetExhaustedReasons(goal).length > 0
  return {
    canPause: goal.status === 'active',
    canStop: goal.status === 'active' || (!running && goal.status !== 'completed' && goal.status !== 'stopped'),
    canEdit: !running,
    canResume: !running && !budgetEditRequired && RESUMABLE.includes(goal.status),
    canClear: !running,
    budgetEditRequired,
  }
}

/** 用户发消息即可自动续上的 Goal：受阻，或被中断 / 重试用尽而暂停。显式暂停与重启暂停需手动恢复。 */
export function isGoalResumableByMessage(goal: Pick<AgentGoalState, 'status' | 'reasonCode' | 'stopReason'>): boolean {
  if (goal.status === 'blocked') return true
  const reason = goal.reasonCode ?? normalizeGoalReason(goal.stopReason)
  return goal.status === 'paused' && (reason === 'user_interrupt' || reason === 'retry_exhausted')
}

/** 旧原因字符串保留在 detail 中；不从模型正文猜测 reason。 */
export function normalizeGoalReason(reason: string | undefined, fallback: AgentGoalReasonCode = 'unknown'): AgentGoalReasonCode {
  if (GOAL_REASON_CODES.includes(reason as AgentGoalReasonCode)) return reason as AgentGoalReasonCode
  if (reason === 'user') return 'user_stop'
  if (reason === 'process_exit') return 'app_restart'
  if (reason === 'max_iterations' || reason === 'max_tokens' || reason === 'max_duration' || reason?.startsWith('已达到 Goal')) return 'budget_limited'
  return fallback
}

export function createGoalLifecycleEvent(input: Omit<AgentGoalLifecycleEvent, 'id'>): AgentGoalLifecycleEvent {
  if (!isGoalTransitionAllowed(input.from, input.to)) throw new Error(`非法 Goal 转移：${input.from} -> ${input.to}`)
  return { ...input, id: `${input.goalId}:${input.revision}:${input.to}` }
}

/** 始终保留创建事件、最近一次终止/清除和最近转移，总量有界。 */
export function capGoalLifecycle(events: AgentGoalLifecycleEvent[]): AgentGoalLifecycleEvent[] {
  if (events.length <= GOAL_LIFECYCLE_LIMIT) return events
  const created = events.find((event) => event.from === null)
  const terminal = [...events].reverse().find((event) => ['completed', 'failed', 'stopped', 'cleared'].includes(event.to))
  const anchors = [created, terminal].filter((event): event is AgentGoalLifecycleEvent => Boolean(event))
  const retained = new Set(anchors.map((event) => event.id))
  for (const event of events.slice().reverse()) {
    if (retained.size >= GOAL_LIFECYCLE_LIMIT) break
    retained.add(event.id)
  }
  return events.filter((event) => retained.has(event.id))
}

const DEFAULT_REASONS: Record<AgentGoalLifecycleTarget, AgentGoalReasonCode> = {
  active: 'resumed', stopping: 'unknown', paused: 'user_pause', stopped: 'user_stop',
  completed: 'completed', blocked: 'blocked', failed: 'failed', budget_limited: 'budget_limited', cleared: 'cleared',
}

export function applyGoalTransition(
  state: AgentGoalState,
  to: AgentGoalLifecycleTarget,
  input: { at: number; reason?: AgentGoalReasonCode; detail?: string; runId?: string },
): AgentGoalState {
  if (state.status === to) return state
  const reason = input.reason ?? DEFAULT_REASONS[to]
  const revision = (state.revision ?? 0) + 1
  const at = Math.max(input.at, state.updatedAt)
  const event = createGoalLifecycleEvent({ goalId: state.id, sessionId: state.sessionId, from: state.status, to, reason, detail: input.detail, revision, at, runId: input.runId })
  return {
    ...state, status: to === 'cleared' ? 'stopped' : to, revision, updatedAt: at,
    reasonCode: reason, reasonDetail: input.detail,
    stopReason: to === 'cleared' ? 'cleared' : to === 'active' ? undefined : input.detail,
    lifecycle: capGoalLifecycle([...(state.lifecycle ?? []), event]),
  }
}

export const GOAL_REASON_LABELS: Record<AgentGoalReasonCode, string> = {
  created: '创建目标', resumed: '恢复执行', user_pause: '用户暂停', user_stop: '用户停止',
  app_restart: '应用退出或重启后暂停', blocked: '等待处理', failed: '执行失败', completed: '验收完成',
  budget_limited: '预算已耗尽', cleared: '清除并归档', superseded: '被新目标替换',
  user_interrupt: '用户中断，发消息即可继续', retry_exhausted: '自动重试 3 次仍失败', run_error: '运行出错', unknown: '历史原因',
}
