import { parseGoalCommand as parseGoalCommandShared, createGoalLifecycleEvent, applyGoalTransition, getGoalBudgetDimensions, getGoalBudgetExhaustedReasons } from '@profer/shared'
import type { AgentGoalContract, AgentGoalIterationResult, AgentGoalState, AgentGoalLimits, AgentGoalCommand, AgentGoalContinuation } from '@profer/shared'

/** 默认不限轮次、时长与 token（对齐 Codex）；只靠连续无进展次数兜底。 */
export const DEFAULT_GOAL_LIMITS: AgentGoalLimits = {
  maxConsecutiveFailures: 3,
}

/** 预算已用比例达到该值后，prompt 要求本轮收尾。 */
const WRAP_UP_RATIO = 0.8

/** Goal 迭代历史保留上限，防止长期运行的 Goal 状态无限膨胀 */
export const GOAL_HISTORY_LIMIT = 20

/** 兼容既有 import；唯一实现已收敛到 @profer/shared（renderer 与 main 共用）。 */
export function parseGoalCommand(input: string): AgentGoalCommand {
  return parseGoalCommandShared(input)
}

/** 本轮是否应收尾：剩最后一轮，或时长/token 预算已用到 80%。 */
export function isGoalNearBudget(state: Pick<AgentGoalState, 'iteration' | 'elapsedMs' | 'usage' | 'limits'>): boolean {
  return getGoalBudgetDimensions(state).some((item) => item.used >= (item.kind === 'iterations' ? item.limit : item.limit * WRAP_UP_RATIO))
}

function describeRemainingBudget(state: Pick<AgentGoalState, 'iteration' | 'elapsedMs' | 'usage' | 'limits'>): string | undefined {
  const parts = getGoalBudgetDimensions(state).map(({ kind, used, limit }) => {
    const remaining = Math.max(0, limit - used)
    return kind === 'iterations' ? `约 ${remaining} 轮` : kind === 'duration' ? `约 ${Math.round(remaining / 60000)} 分钟` : `${remaining} tokens`
  })
  return parts.length ? parts.join(' / ') : undefined
}

/**
 * 组装 Goal 单轮迭代 prompt（对齐 Codex continuation：plan→act→verify→review）。
 * 注入目标契约与剩余预算，让 Agent 在明确的验收标准与边界内工作。
 */
export function buildGoalIterationPrompt(
  state: Pick<AgentGoalState, 'goal' | 'contract' | 'iteration' | 'limits' | 'startedAt' | 'history' | 'elapsedMs' | 'usage'>,
  input: { previousSummary?: string; now?: number },
): string {
  // 调用方在进入本轮前已经自增轮次；暂停与空闲时间不消耗预算。
  const displayIteration = Math.max(1, state.iteration)
  const lines = [
    `你正在持续执行一个 Goal（长时自主任务）。目标：${state.goal}`,
  ]
  if (state.contract?.verification) lines.push(`验收标准（verify）：${state.contract.verification}`)
  if (state.contract?.constraints) lines.push(`约束（constraint）：${state.contract.constraints}`)
  if (state.contract?.stopWhen) lines.push(`停止条件（stop）：${state.contract.stopWhen}`)
  const remaining = describeRemainingBudget(state)
  lines.push(`这是第 ${displayIteration} 轮。${remaining ? `剩余预算：${remaining}。` : ''}不得缩小目标来迎合预算。`)
  if (input.previousSummary) lines.push(`上一轮摘要：${input.previousSummary}`)
  const recentHistory = (state.history ?? []).slice(-3)
  if (recentHistory.length > 0) {
    lines.push('近期迭代轨迹：')
    for (const record of recentHistory) {
      lines.push(`- 第 ${record.iteration} 轮（${record.status}）：${record.summary.slice(0, 200)}`)
    }
  }
  lines.push(
    [
      '工作方式：以工作区的真实状态为准，先判断上一轮属于「有进展 / 已核实的等待 / 无进展」，再规划本轮动作并实际执行（不要只给建议），然后验证结果。多步任务请用任务图拆解并与 Goal 对齐。',
      state.contract?.verification
        ? '完成判定：只有当验收标准被真实证据满足时才算完成。'
        : '完成判定：请先为这个目标拟定可验证的验收标准，后续轮次以证据满足它为准。',
      '完成前逐项核对原目标与验收标准：列出每项要求、实际证据、尚未完成的部分；证据不足就继续做，不得只用本轮局部成功代表整个目标完成。',
      '汇报方式：目标逐项验收完成时调用 update_goal(status=complete, summary, evidence)，evidence 必须是真实证据；确实需要用户输入或外部状态变化才能继续时调用 update_goal(status=blocked) 并说明缺口与恢复条件。其余情况正常结束本轮即可，宿主会自动开始下一轮；连续无进展会被宿主停止。update_goal 是内部控制通道，不要在普通回复中输出 XML/JSON 协议。',
    ].join('\n'),
  )
  if (isGoalNearBudget(state)) {
    lines.push('预算即将用完：本轮请收尾，不要开始新的大块工作；整理已完成的部分与证据，如实说明尚未完成的部分。预算不足不等于完成，不得冒充 complete。')
  }
  return lines.join('\n')
}

export function createGoalState(sessionId: string, goal: string, now = Date.now(), limits = DEFAULT_GOAL_LIMITS, contract?: AgentGoalContract, revision = 1): AgentGoalState {
  const id = crypto.randomUUID()
  return {
    id,
    sessionId,
    goal: goal.trim(),
    status: 'active',
    iteration: 0,
    consecutiveFailures: 0,
    startedAt: now,
    updatedAt: now,
    limits: { ...limits },
    revision,
    reasonCode: 'created',
    lifecycle: [createGoalLifecycleEvent({ goalId: id, sessionId, from: null, to: 'active', reason: 'created', revision, at: now })],
    elapsedMs: 0,
    contract,
    history: [],
  }
}

/** 第一条预算耗尽原因；判定规则与 renderer 共用 shared 实现。 */
export function goalBudgetReason(state: Pick<AgentGoalState, 'iteration' | 'elapsedMs' | 'usage' | 'limits'>): string | undefined {
  return getGoalBudgetExhaustedReasons(state)[0]
}

export function evaluateGoalContinuation(
  result: AgentGoalIterationResult,
  context: { iteration: number; consecutiveFailures: number; startedAt: number; now: number; elapsedMs?: number; totalTokens?: number; limits: AgentGoalLimits; turnFailed?: boolean },
): AgentGoalContinuation {
  if (result.outcome === 'deferred') return { action: 'deferred', consecutiveFailures: context.consecutiveFailures }
  if (result.outcome === 'stopped') return { action: 'stopped', consecutiveFailures: context.consecutiveFailures, reason: result.error ?? '用户停止执行' }
  const hasEvidence = result.evidence.some((item) => typeof item === 'string' && item.trim().length > 0)
  // continue 不要求证据（对齐 Codex）；只有运行失败/无进展，或无证据声称完成才计入失败。
  const failed = context.turnFailed || result.outcome === 'failed' || (result.status === 'complete' && !hasEvidence)
  const failures = failed ? context.consecutiveFailures + 1 : 0
  // 完整最后一轮仍可完成：预算只在轮次边界检查。
  if (!failed && result.status === 'complete') return { action: 'complete', consecutiveFailures: 0 }
  if (!failed && result.status === 'blocked') return { action: 'blocked', consecutiveFailures: failures, reason: result.summary }
  const reason = goalBudgetReason({ iteration: context.iteration, elapsedMs: context.elapsedMs ?? Math.max(0, context.now - context.startedAt), usage: { inputTokens: 0, outputTokens: 0, totalTokens: context.totalTokens ?? 0 }, limits: context.limits })
  if (reason) return { action: 'limit_reached', consecutiveFailures: failures, reason }
  if (failures >= context.limits.maxConsecutiveFailures) return { action: 'failed', consecutiveFailures: failures, reason: result.error ?? '连续无进展次数达到上限' }
  return { action: 'continue', consecutiveFailures: failures }
}

export function parseGoalIterationResult(text: string): AgentGoalIterationResult {
  // 会话里同时存在控制 prompt 中的协议示例（status 值为 "continue|complete|blocked"）
  // 和本轮真实输出；从尾部向前找第一个解析成功且 status 合法的块。
  const matches = [...text.matchAll(/<goal_result>\s*([\s\S]*?)\s*<\/goal_result>/gi)]
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]![1] ?? '') as Partial<AgentGoalIterationResult>
      if (parsed.status !== 'continue' && parsed.status !== 'complete' && parsed.status !== 'blocked') continue
      return {
        status: parsed.status,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [],
      }
    } catch {
      continue
    }
  }
  if (matches.length > 0) {
    return { status: 'continue', summary: 'Goal 结果协议解析失败，继续执行并要求下一轮重新汇报。', evidence: [] }
  }
  return { status: 'continue', summary: text.slice(-2000), evidence: [] }
}

export function stopGoalForProcessExit(goal: AgentGoalState, now = Date.now()): AgentGoalState {
  return applyGoalTransition(goal, 'stopped', { at: now, reason: 'app_restart', detail: 'process_exit', runId: goal.activeRunId })
}

/**
 * 应用进程退出时的 Goal 语义（Codex 式持久目标）：不判死刑，
 * 降级为 paused 并标记 app_restart，重启后用户可显式 resume。
 */
export function pauseGoalForProcessExit(goal: AgentGoalState, now = Date.now()): AgentGoalState {
  return applyGoalTransition(goal, 'paused', { at: now, reason: 'app_restart', detail: 'app_restart', runId: goal.activeRunId })
}
