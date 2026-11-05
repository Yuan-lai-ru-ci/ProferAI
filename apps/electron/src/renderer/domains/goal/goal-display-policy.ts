import { isGoalResumableByMessage, normalizeGoalReason } from '@profer/shared'
import type { AgentGoalState } from '@profer/shared'

const GOAL_STATUS_LABELS: Record<AgentGoalState['status'], string> = {
  active: '执行中', stopping: '正在停止', paused: '已暂停', completed: '已完成',
  blocked: '等待处理', failed: '执行失败', stopped: '已停止', budget_limited: '预算已耗尽',
}

/** Goal 显示域只接收状态事实，不读取 atom、IPC 或组件。 */
export function isGoalRunning(goal: AgentGoalState | undefined): boolean {
  return (goal?.status === 'active' || goal?.status === 'stopping') && Boolean(goal.activeRunId)
}

/**
 * 需要用户介入才能继续的 Goal：受阻等输入、预算耗尽要扩预算。
 *
 * 侧栏角标只该在这种情况亮——正在跑的目标不需要你管，
 * 「有目标存在」也不等于「有事等你」，否则角标不传递任何信息。
 */
export function needsGoalAttention(goal: Pick<AgentGoalState, 'status'>): boolean {
  return goal.status === 'blocked' || goal.status === 'budget_limited'
}

/** 侧栏入口的计数口径：未结束即计入（含暂停、受阻、预算耗尽）。 */
export function isGoalLive(goal: Pick<AgentGoalState, 'status'>): boolean {
  return goal.status !== 'completed' && goal.status !== 'stopped' && goal.status !== 'failed'
}

/** 侧栏入口的分档摘要：把「执行中」和「其他未结束」分开，避免把暂停说成进行中。 */
export function summarizeGoalRailCounts(goals: Iterable<Pick<AgentGoalState, 'status'>>): { live: number; running: number; attention: number } {
  let live = 0
  let running = 0
  let attention = 0
  for (const goal of goals) {
    if (!isGoalLive(goal)) continue
    live += 1
    if (goal.status === 'active' || goal.status === 'stopping') running += 1
    if (needsGoalAttention(goal)) attention += 1
  }
  return { live, running, attention }
}

export function formatGoalElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
}

export function getGoalElapsed(goal: AgentGoalState, now: number): number {
  return Math.max(0, goal.elapsedMs ?? 0) + (isGoalRunning(goal) ? Math.max(0, now - goal.updatedAt) : 0)
}

export function formatGoalBudget(limits: AgentGoalState['limits']): string {
  const parts = [
    limits.maxIterations === undefined ? '' : `${limits.maxIterations} 轮`,
    limits.maxDurationMs === undefined ? '' : formatGoalElapsed(limits.maxDurationMs),
    limits.maxTokens === undefined ? '' : `${limits.maxTokens.toLocaleString()} tokens`,
  ].filter(Boolean)
  return `${parts.length ? parts.join(' · ') : '不限'}（连续 ${limits.maxConsecutiveFailures} 轮无进展时停止）`
}

/** active 期间区分真实运行与等待；操作权限仍由 shared getGoalActions 决定。 */
export function getGoalStatusLabel(
  goal: AgentGoalState,
  waits: { askUser: number; permission: number },
  now: number,
): string {
  if (goal.status === 'active') {
    if (waits.askUser > 0) return '等待你的回答'
    if (waits.permission > 0) return '等待审批'
    if (goal.waiting === 'plan_mode') return '计划模式中，切换为可执行模式后自动继续'
    if (goal.retry && !goal.activeRunId) return `运行出错，${formatGoalElapsed(Math.max(0, goal.retry.nextAt - now))}后第 ${goal.retry.attempt} 次重试`
    if (goal.activeRunId) return GOAL_STATUS_LABELS.active
    if (goal.idleCheckin?.paused) return '空闲自检已暂停 · 发消息即可继续'
    if (goal.idleCheckin?.nextAt !== undefined) {
      return `空闲中，${formatGoalElapsed(Math.max(0, goal.idleCheckin.nextAt - now))}后自动继续${goal.idleCheckin.count > 0 ? `（第 ${goal.idleCheckin.count + 1} 次）` : ''}`
    }
    return '等待会话空闲'
  }
  if (isGoalResumableByMessage(goal)) return `${GOAL_STATUS_LABELS[goal.status]} · ${goal.status === 'blocked' ? '发消息补充后自动继续' : '发消息即可继续'}`
  if ((goal.reasonCode ?? normalizeGoalReason(goal.stopReason)) === 'app_restart') return `${GOAL_STATUS_LABELS[goal.status]} · 重启后待恢复`
  return GOAL_STATUS_LABELS[goal.status]
}

/** 需要主动告知用户的 Goal 终态；用户主动暂停/停止不打扰。 */
const TERMINAL_NOTIFICATION_STATUSES: ReadonlySet<AgentGoalState['status']> = new Set(['completed', 'blocked', 'failed', 'budget_limited'])
/** 这些暂停原因意味着「卡住了，需要人处理」，不能因为状态叫 paused 就不提醒。 */
const NEEDS_ACTION_PAUSE_REASONS: ReadonlySet<string> = new Set(['retry_exhausted', 'run_error'])

/**
 * Goal 需要用户知道结果时的通知文案（纯函数，便于测试）。
 * 返回 null 表示不需要通知：正常进行中、用户主动暂停/停止、或已清除归档。
 * 运行错误重试用尽后状态是 paused 而不是 failed，这种情况必须纳入，
 * 否则用户离开时最需要提醒的「卡住了」反而静默。
 */
export function getGoalTerminalNotification(
  goal: Pick<AgentGoalState, 'status' | 'goal' | 'reasonCode' | 'stopReason' | 'lastSummary'>,
): { title: string; body: string } | null {
  const reason = goal.reasonCode ?? normalizeGoalReason(goal.stopReason)
  if (reason === 'cleared' || goal.stopReason === 'cleared' || reason === 'user_stop') return null
  const detail = goal.lastSummary || goal.stopReason || goal.goal
  if (goal.status === 'paused') {
    if (!NEEDS_ACTION_PAUSE_REASONS.has(reason)) return null
    return { title: 'Goal 已暂停，需要你处理', body: detail }
  }
  if (!TERMINAL_NOTIFICATION_STATUSES.has(goal.status)) return null
  const title = goal.status === 'completed' ? 'Goal 已完成'
    : goal.status === 'blocked' ? 'Goal 受阻，等待你的输入'
    : goal.status === 'budget_limited' ? 'Goal 预算已耗尽'
    : 'Goal 执行失败'
  return { title, body: detail }
}
