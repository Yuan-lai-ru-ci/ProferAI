import { describe, expect, test } from 'bun:test'
import {
  HandoffProposalService,
  MAX_PENDING_HANDOFF_PROPOSALS,
  normalizeHandoffProposalInput,
} from './handoff-proposal-service'

describe('交接对话提议参数', () => {
  test('Given 理由为空 When 归一 Then 视为无效提议', () => {
    expect(normalizeHandoffProposalInput({ reason: '   ' })).toBeNull()
    expect(normalizeHandoffProposalInput({ reason: 42 })).toBeNull()
  })

  test('Given 合法输入 When 归一 Then 去空白并裁剪，保留可选下一步', () => {
    expect(normalizeHandoffProposalInput({ reason: '  上下文太长了  ', nextSteps: '  先读文档  ' })).toEqual({
      reason: '上下文太长了',
      nextSteps: '先读文档',
    })
    expect(normalizeHandoffProposalInput({ reason: 'x'.repeat(1500) })?.reason).toHaveLength(1000)
  })
})

describe('交接对话提议队列', () => {
  test('Given 登记一条提议 When 读取 Then 带 id / sessionId / 时间', () => {
    const service = new HandoffProposalService()
    const proposal = service.add('s1', { reason: '阶段完成' })
    expect(proposal).not.toBeNull()
    expect(proposal?.id).toBeTruthy()
    expect(proposal?.sessionId).toBe('s1')
    expect(proposal?.reason).toBe('阶段完成')
    expect(proposal?.createdAt).toBeGreaterThan(0)
  })

  test('Given peek When 读取 Then 不出队（失败时卡片可重试）', () => {
    const service = new HandoffProposalService()
    const proposal = service.add('s1', { reason: 'r' })!
    expect(service.peek(proposal.id)?.id).toBe(proposal.id)
    expect(service.hasPending('s1')).toBe(true)
  })

  test('Given 超过单会话上限 When 继续登记 Then 丢弃最旧的一条', () => {
    const service = new HandoffProposalService()
    const ids: string[] = []
    for (let i = 0; i < MAX_PENDING_HANDOFF_PROPOSALS + 1; i += 1) {
      ids.push(service.add('s1', { reason: `r${i}` })!.id)
    }
    const remaining = service.listForSession('s1').map((item) => item.id)
    expect(remaining).toHaveLength(MAX_PENDING_HANDOFF_PROPOSALS)
    expect(remaining).not.toContain(ids[0])
    expect(remaining).toContain(ids[ids.length - 1]!)
  })

  test('Given 多个会话 When clearSession Then 只清目标会话', () => {
    const service = new HandoffProposalService()
    service.add('s1', { reason: 'a' })
    const other = service.add('s2', { reason: 'b' })!
    service.clearSession('s1')
    expect(service.list().map((item) => item.id)).toEqual([other.id])
    expect(service.hasPending('s1')).toBe(false)
  })

  test('Given remove 不存在的 id When 调用 Then 返回 null', () => {
    expect(new HandoffProposalService().remove('missing')).toBeNull()
  })
})
