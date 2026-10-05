import type { AgentGoalContract, AgentGoalLimitsPatch } from '@profer/shared'

export interface GoalUpdatePatch {
  goal?: string
  contract?: AgentGoalContract
  limits?: AgentGoalLimitsPatch
}

/** IPC 输入来自 renderer，数值和文本在修改目标前统一验证。 */
export function validateGoalUpdatePatch(value: unknown): GoalUpdatePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的 Goal 更新参数')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['goal', 'contract', 'limits'].includes(key))) throw new Error('Goal 更新包含未知字段')
  const patch: GoalUpdatePatch = {}
  if (input.goal !== undefined) {
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 20000) throw new Error('Goal 目标不能为空或过长')
    patch.goal = input.goal.trim()
  }
  if (input.contract !== undefined) {
    if (!input.contract || typeof input.contract !== 'object' || Array.isArray(input.contract)) throw new Error('无效的 Goal 契约')
    const contract = input.contract as Record<string, unknown>
    if (Object.keys(contract).some((key) => !['verification', 'constraints', 'stopWhen'].includes(key))) throw new Error('Goal 契约包含未知字段')
    patch.contract = {}
    for (const key of ['verification', 'constraints', 'stopWhen'] as const) {
      const text = contract[key]
      if (text === undefined) continue
      if (typeof text !== 'string' || text.length > 10000) throw new Error('Goal 契约必须为文本且不能过长')
      patch.contract[key] = text.trim()
    }
  }
  if (input.limits !== undefined) {
    if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) throw new Error('无效的 Goal 预算')
    const limits = input.limits as Record<string, unknown>
    if (Object.keys(limits).some((key) => !['maxIterations', 'maxDurationMs', 'maxTokens', 'maxConsecutiveFailures'].includes(key))) throw new Error('Goal 预算包含未知字段')
    patch.limits = {}
    for (const key of ['maxIterations', 'maxDurationMs', 'maxTokens', 'maxConsecutiveFailures'] as const) {
      const number = limits[key]
      if (number === undefined) continue
      // null 清除该项预算（不限）；连续无进展上限必须保留。
      if (number === null && key !== 'maxConsecutiveFailures') { patch.limits[key] = null; continue }
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error('Goal 预算必须为有限的正整数')
      patch.limits[key] = number
    }
  }
  return patch
}
