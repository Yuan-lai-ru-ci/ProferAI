import { describe, expect, test } from 'bun:test'
import { GoalProposalService, MAX_PENDING_GOAL_PROPOSALS, normalizeGoalProposalInput, normalizeGoalProposalPolicy } from './goal-proposal-service'

describe('Goal 提议参数解析', () => {
  test('目标为空视为无效提议', () => {
    expect(normalizeGoalProposalInput({ objective: '   ' })).toBeNull()
    expect(normalizeGoalProposalInput({ objective: 42 as unknown as string })).toBeNull()
  })

  test('只填目标时没有契约', () => {
    expect(normalizeGoalProposalInput({ objective: ' 把迁移做完 ' })).toEqual({ objective: '把迁移做完', rationale: '' })
  })

  test('验收/约束/停止条件合成契约，并裁掉空白', () => {
    const parsed = normalizeGoalProposalInput({ objective: '迁移', rationale: '需要多轮', verification: ' 全部测试通过 ', constraints: '', stopWhen: '需要线上权限' })
    expect(parsed?.contract).toEqual({ verification: '全部测试通过', constraints: undefined, stopWhen: '需要线上权限' })
  })

  test('策略只认三个合法值，其余回退 alwaysAsk', () => {
    expect(normalizeGoalProposalPolicy('auto')).toBe('auto')
    expect(normalizeGoalProposalPolicy('disabled')).toBe('disabled')
    expect(normalizeGoalProposalPolicy('alwaysAsk')).toBe('alwaysAsk')
    expect(normalizeGoalProposalPolicy('whatever')).toBe('alwaysAsk')
    expect(normalizeGoalProposalPolicy(undefined)).toBe('alwaysAsk')
  })
})

describe('Goal 提议队列', () => {
  test('登记后可读取、可消费，消费后不再存在', () => {
    const service = new GoalProposalService()
    const created = service.add('s1', { objective: '目标A' })
    expect(created?.proposal.sessionId).toBe('s1')
    expect(service.listForSession('s1')).toHaveLength(1)
    const taken = service.take(created!.proposal.id)
    expect(taken?.contract).toBeUndefined()
    expect(service.list()).toHaveLength(0)
    expect(service.take(created!.proposal.id)).toBeNull()
  })

  test('同一会话超过上限时丢弃最旧的一条', () => {
    const service = new GoalProposalService()
    const ids: string[] = []
    for (let index = 0; index < MAX_PENDING_GOAL_PROPOSALS + 1; index++) {
      const created = service.add('s1', { objective: `目标${index}` })
      ids.push(created!.proposal.id)
      // createdAt 精度为毫秒：确保排序稳定
      service.list()
    }
    const remaining = service.listForSession('s1')
    expect(remaining).toHaveLength(MAX_PENDING_GOAL_PROPOSALS)
    expect(remaining.some((item) => item.id === ids[0])).toBe(false)
  })

  test('hasPending 只按会话判断，忽略与清空都会移除', () => {
    const service = new GoalProposalService()
    expect(service.hasPending('s1')).toBe(false)
    const created = service.add('s1', { objective: '目标A' })!
    expect(service.hasPending('s1')).toBe(true)
    expect(service.hasPending('s2')).toBe(false)
    service.clearSession('s1')
    expect(service.hasPending('s1')).toBe(false)
    expect(created.proposal.id).toBeTruthy()
  })

  test('remove 返回被移除的提议，重复移除返回 null', () => {
    const service = new GoalProposalService()
    const created = service.add('s1', { objective: '目标A' })!
    expect(service.remove(created.proposal.id)?.objective).toBe('目标A')
    expect(service.remove(created.proposal.id)).toBeNull()
  })
})
