import { parseGoalCommand as parseGoalCommandShared, createGoalLifecycleEvent, applyGoalTransition } from '@profer/shared'
import type { AgentGoalContract, AgentGoalIterationResult, AgentGoalState, AgentGoalLimits, AgentGoalCommand, AgentGoalContinuation } from '@profer/shared'

export const DEFAULT_GOAL_LIMITS: AgentGoalLimits = {
  maxIterations: 20,
  maxConsecutiveFailures: 3,
  maxDurationMs: 2 * 60 * 60 * 1000,
}

/** Goal 迭代历史保留上限，防止长期运行的 Goal 状态无限膨胀 */
export const GOAL_HISTORY_LIMIT = 20

/** 兼容既有 import；唯一实现已收敛到 @profer/shared（renderer 与 main 共用）。 */
export function parseGoalCommand(input: string): AgentGoalCommand {
  return parseGoalCommandShared(input)
}

/**
 * 组装 Goal 单轮迭代 prompt（Codex 式 plan→act→verify→review 循环）。
 * 注入目标契约与剩余预算，让 Agent 在明确的验收标准与边界内工作。
 */
export function buildGoalIterationPrompt(
  state: Pick<AgentGoalState, 'goal' | 'contract' | 'iteration' | 'limits' | 'startedAt' | 'history' | 'elapsedMs' | 'usage'>,
  input: { previousSummary?: string; now?: number },
): string {
  // 调用方在进入本轮前已经自增轮次；暂停与空闲时间不消耗预算。
  const iteration = state.iteration
  const remainingIterations = Math.max(0, state.limits.maxIterations - iteration)
  const remainingMinutes = Math.max(0, Math.round((state.limits.maxDurationMs - (state.elapsedMs ?? 0)) / 60000))
  const displayIteration = Math.max(1, iteration)
  const lines = [
    `你正在持续执行一个 Goal（长时自主任务）。目标：${state.goal}`,
  ]
  if (state.contract?.verification) lines.push(`验收标准（verify）：${state.contract.verification}`)
  if (state.contract?.constraints) lines.push(`约束（constraint）：${state.contract.constraints}`)
  if (state.contract?.stopWhen) lines.push(`停止条件（stop）：${state.contract.stopWhen}`)
  lines.push(`这是第 ${displayIteration} 轮。剩余预算：约 ${remainingIterations} 轮 / ${remainingMinutes} 分钟。预算不足不等于完成，不得缩小目标来迎合预算。`)
  if (state.limits.maxTokens !== undefined) lines.push(`剩余 token 预算：${Math.max(0, state.limits.maxTokens - (state.usage?.totalTokens ?? 0))}（在用量记账边界检查）。`)
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
      '工作方式：先规划本轮动作，再实际执行（不要只给建议），然后验证结果并复盘。多步任务请用任务图拆解并与 Goal 对齐。',
      state.contract?.verification
        ? '完成判定：只有当验收标准被真实证据满足时才允许 complete。'
        : '完成判定：本轮请先为这个目标拟定可验证的验收标准并写入 summary，后续轮次以证据满足它为准。',
      '完成前逐项核对原目标与验收标准：列出每项要求、实际证据、尚未完成的部分；不得只用本轮局部成功代表整个目标完成。',
      'continue 需要实际进展证据。无进展时如实说明尝试、失败原因和下一步；重复无进展会由宿主停止。blocked 需要说明确切缺口及恢复条件。',
      '每轮结束时必须调用 update_goal 报告结构化结果（status=continue|complete|blocked、summary、evidence）。这是内部控制通道，不要在普通回复中输出 XML/JSON 协议。只有逐项验收完成且 evidence 包含非空真实证据时才使用 complete；预算不足保持诚实的未完成报告，不得冒充 complete。若工具不可用，说明问题，由宿主按报告缺失处理。',
    ].join('\n'),
  )
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

export function goalBudgetReason(state: Pick<AgentGoalState, 'iteration' | 'elapsedMs' | 'usage' | 'limits'>): string | undefined {
  if ((state.elapsedMs ?? 0) >= state.limits.maxDurationMs) return '已达到 Goal 最大运行时长'
  if (state.iteration >= state.limits.maxIterations) return '已达到 Goal 最大迭代轮次'
  if (state.limits.maxTokens !== undefined && (state.usage?.totalTokens ?? 0) >= state.limits.maxTokens) return '已达到 Goal token 预算'
  return undefined
}

export function evaluateGoalContinuation(
  result: AgentGoalIterationResult,
  context: { iteration: number; consecutiveFailures: number; startedAt: number; now: number; elapsedMs?: number; totalTokens?: number; limits: AgentGoalLimits; turnFailed?: boolean },
): AgentGoalContinuation {
  if (result.outcome === 'deferred') return { action: 'deferred', consecutiveFailures: context.consecutiveFailures }
  if (result.outcome === 'stopped') return { action: 'stopped', consecutiveFailures: context.consecutiveFailures, reason: result.error ?? '用户停止执行' }
  const hasEvidence = result.evidence.some((item) => typeof item === 'string' && item.trim().length > 0)
  const failed = context.turnFailed || result.outcome === 'failed' || (result.status !== 'blocked' && !hasEvidence)
  const failures = failed ? context.consecutiveFailures + 1 : 0
  // 完整最后一轮仍可完成；运行 deadline 已取消的结果由 Controller fence 丢弃。
  if (!failed && result.status === 'complete') return { action: 'complete', consecutiveFailures: 0 }
  if (!failed && result.status === 'blocked') return { action: 'blocked', consecutiveFailures: failures, reason: result.summary }
  const reason = goalBudgetReason({ iteration: context.iteration, elapsedMs: context.elapsedMs ?? Math.max(0, context.now - context.startedAt), usage: { inputTokens: 0, outputTokens: 0, totalTokens: context.totalTokens ?? 0 }, limits: context.limits })
  if (reason) return { action: 'limit_reached', consecutiveFailures: failures, reason }
  if (failures >= context.limits.maxConsecutiveFailures) return { action: 'failed', consecutiveFailures: failures, reason: result.error ?? '连续执行失败或无进展次数达到上限' }
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
