import type { AgentGoalCommand, AgentGoalContract, AgentGoalLimits, AgentGoalState } from '../types/agent'

export interface GoalLimitsInput {
  maxIterations: string
  maxDurationMinutes: string
  maxConsecutiveFailures: string
  maxTokens: string
}

/** 预算修改补丁：null 表示清除该项预算（不限）。 */
export type AgentGoalLimitsPatch = {
  [K in keyof AgentGoalLimits]?: K extends 'maxConsecutiveFailures' ? number : number | null
}

/** 表单预算采用严格十进制；轮次、时长、token 留空均表示不限，非法值拒绝而不是静默当作不限。 */
export function parseGoalLimitsInput(input: GoalLimitsInput): AgentGoalLimitsPatch {
  const positiveInteger = (value: string, label: string): number => {
    const text = value.trim()
    const number = Number(text)
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`${label}必须是正整数`)
    }
    return number
  }
  const optionalInteger = (value: string, label: string): number | null => value.trim() ? positiveInteger(value, label) : null
  const minutes = input.maxDurationMinutes.trim()
  let maxDurationMs: number | null = null
  if (minutes) {
    maxDurationMs = Number(minutes) * 60000
    if (!/^\d+(?:\.\d+)?$/.test(minutes) || !Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) {
      throw new Error('运行时长必须是有效正数，精确到毫秒且不能超出安全范围')
    }
  }
  return {
    maxIterations: optionalInteger(input.maxIterations, '轮次上限'),
    maxDurationMs,
    maxConsecutiveFailures: positiveInteger(input.maxConsecutiveFailures, '连续无进展上限'),
    maxTokens: optionalInteger(input.maxTokens, 'Token 上限'),
  }
}

const OPTIONAL_LIMIT_KEYS = ['maxIterations', 'maxDurationMs', 'maxTokens'] as const

/** 把预算补丁合并到现有预算；null 删除对应字段。 */
export function applyGoalLimitsPatch(limits: AgentGoalLimits, patch: AgentGoalLimitsPatch): AgentGoalLimits {
  const next: AgentGoalLimits = { ...limits }
  for (const key of OPTIONAL_LIMIT_KEYS) {
    const value = patch[key]
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  if (patch.maxConsecutiveFailures !== undefined) next.maxConsecutiveFailures = patch.maxConsecutiveFailures
  return next
}

/** 预算唯一校验规则：无进展上限必填，其余可选；设置时为正数，轮次与 token 为整数。 */
export function isValidGoalLimits(limits: unknown): limits is AgentGoalLimits {
  if (!limits || typeof limits !== 'object') return false
  const value = limits as Record<string, unknown>
  const positive = (number: unknown, integer: boolean) => typeof number === 'number' && (integer ? Number.isSafeInteger(number) : Number.isFinite(number)) && number > 0
  const optional = (number: unknown, integer: boolean) => number === undefined || positive(number, integer)
  return positive(value.maxConsecutiveFailures, true) && optional(value.maxIterations, true) && optional(value.maxDurationMs, false) && optional(value.maxTokens, true)
}

export interface GoalBudgetDimension {
  kind: 'iterations' | 'duration' | 'tokens'
  used: number
  limit: number
}

type GoalBudgetSource = Pick<AgentGoalState, 'iteration' | 'elapsedMs' | 'usage' | 'limits'>

/** 已设置的预算维度及其用量；未设置的维度视为不限，不出现在结果中。 */
export function getGoalBudgetDimensions(goal: GoalBudgetSource): GoalBudgetDimension[] {
  const dimensions: GoalBudgetDimension[] = []
  if (goal.limits.maxIterations !== undefined) dimensions.push({ kind: 'iterations', used: goal.iteration, limit: goal.limits.maxIterations })
  if (goal.limits.maxDurationMs !== undefined) dimensions.push({ kind: 'duration', used: goal.elapsedMs ?? 0, limit: goal.limits.maxDurationMs })
  if (goal.limits.maxTokens !== undefined) dimensions.push({ kind: 'tokens', used: goal.usage?.totalTokens ?? 0, limit: goal.limits.maxTokens })
  return dimensions
}

const BUDGET_EXHAUSTED_LABELS: Record<GoalBudgetDimension['kind'], string> = {
  iterations: '已达到轮次上限', duration: '已达到净运行时长上限', tokens: '已达到 Token 上限',
}

/** 展示、恢复准入与轮次准入共用的预算耗尽判定。 */
export function getGoalBudgetExhaustedReasons(goal: GoalBudgetSource): string[] {
  return getGoalBudgetDimensions(goal).filter((item) => item.used >= item.limit).map((item) => BUDGET_EXHAUSTED_LABELS[item.kind])
}

const GOAL_SUBCOMMANDS = ['status', 'pause', 'resume', 'stop', 'clear'] as const

/**
 * 解析 `/goal` 输入（renderer 与 main 共用的唯一实现）。
 * 支持 Codex 式契约行标记（沿用 pi-harness @verify/@artifact 的声明式行标记传统）：
 *   /goal 完成登录页
 *   @verify: pnpm test:e2e login 通过
 *   @constraint: 不修改支付相关代码
 *   @stop: 需要生产环境凭据时
 * 标记行不进入 goal 文本本身。
 */
export function parseGoalCommand(input: string): AgentGoalCommand {
  const trimmed = input.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return { type: 'not_goal' }
  const rest = trimmed.replace(/^\/goal\s*/i, '').trim()
  if (!rest) return { type: 'invalid', reason: '目标不能为空，例如：/goal 完成登录页' }
  const single = rest.toLowerCase()
  if (!rest.includes('\n') && (GOAL_SUBCOMMANDS as readonly string[]).includes(single)) {
    return { type: single as 'status' | 'pause' | 'resume' | 'stop' | 'clear' }
  }
  if (/^[a-z]+$/.test(single)) {
    return { type: 'invalid', reason: `未知的 Goal 命令：${rest}` }
  }
  const { goal, contract } = parseGoalContractInput(rest)
  if (!goal) return { type: 'invalid', reason: '目标不能为空，契约标记之外需要一行目标描述' }
  return { type: 'start', goal, contract }
}

/**
 * 从 `/goal` 正文中分离目标文本与契约标记。
 * 每类契约标记取第一条有效行（≤240 字符），其余行视为目标描述。
 */
export function parseGoalContractInput(text: string): { goal: string; contract?: AgentGoalContract } {
  const goalLines: string[] = []
  const contract: AgentGoalContract = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(/^@(verify|constraint|constraints|stop):\s*(\S.*)$/i)
    if (match) {
      const value = match[2]!.trim()
      if (value.length <= 240) {
        const kind = match[1]!.toLowerCase()
        if (kind === 'verify' && !contract.verification) contract.verification = value
        else if (kind.startsWith('constraint') && !contract.constraints) contract.constraints = value
        else if (kind === 'stop' && !contract.stopWhen) contract.stopWhen = value
      }
      continue
    }
    goalLines.push(rawLine)
  }
  const goal = goalLines.join('\n').trim()
  const hasContract = Boolean(contract.verification || contract.constraints || contract.stopWhen)
  return { goal, contract: hasContract ? contract : undefined }
}

/**
 * 从展示文本中剥离 <goal_result> 机器协议块。
 * 仅兼容旧消息展示；main 不再把文本块视为可信控制报告。
 * 未闭合的尾部块（流式中途）一并剥离。
 */
export function stripGoalResultBlocks(text: string): string {
  return text.replace(/<goal_result>[\s\S]*?(<\/goal_result>|$)/gi, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

export const GOAL_UPDATE_TOOL_NAME = 'update_goal'

/** Goal 内部状态工具不应作为普通工具过程展示。 */
export function isGoalUpdateToolName(name: unknown): boolean {
  return name === GOAL_UPDATE_TOOL_NAME || name === `mcp__goal__${GOAL_UPDATE_TOOL_NAME}`
}

/** 判断 SDK user 消息是否为 Goal 迭代注入的控制消息（带 _goalIteration 标记） */
export function isGoalIterationMessage(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && (message as { _goalIteration?: unknown })._goalIteration != null)
}
