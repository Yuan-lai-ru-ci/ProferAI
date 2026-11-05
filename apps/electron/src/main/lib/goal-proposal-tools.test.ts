import { describe, expect, test } from 'bun:test'
import { shouldInjectGoalProposalTool } from './goal-proposal-tools'

describe('propose_goal 注入条件', () => {
  const base = { policy: 'alwaysAsk' as const, hasActiveGoal: false, planMode: false }

  test('普通轮次注入', () => {
    expect(shouldInjectGoalProposalTool(base)).toBe(true)
    expect(shouldInjectGoalProposalTool({ ...base, policy: 'auto' })).toBe(true)
  })

  test('关闭策略不注入', () => {
    expect(shouldInjectGoalProposalTool({ ...base, policy: 'disabled' })).toBe(false)
  })

  test('已有 Goal 时不再提议（避免同一会话两个目标）', () => {
    expect(shouldInjectGoalProposalTool({ ...base, hasActiveGoal: true })).toBe(false)
  })

  test('计划模式下不提议（用户还没确认要做）', () => {
    expect(shouldInjectGoalProposalTool({ ...base, planMode: true })).toBe(false)
  })
})
