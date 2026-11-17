import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload } from '@profer/shared'
import { payloadToLegacyEvents } from './useGlobalAgentListeners'

const proposalEvent = (type: string, extra: Record<string, unknown> = {}): AgentStreamPayload => ({
  kind: 'profer_event',
  event: { type, ...extra } as never,
})

describe('提议卡片事件 → 旧流事件', () => {
  test('卡片队列事件不投影成运行时事件，晚到的 resolved 也不能凭空造出 Agent Running', () => {
    // 用户可能在 run 结束很久后才点忽略/确认；此刻没有流状态，一旦投影成旧事件，
    // 监听循环会兜底捏出 { running: true }，而 applyAgentEvent 不处理这些类型，
    // 界面就永远停在「Agent Running」。
    for (const payload of [
      proposalEvent('goal_proposal', { proposal: { id: 'goal-1' } }),
      proposalEvent('goal_proposal_resolved', { proposalId: 'goal-1', accepted: false }),
      proposalEvent('handoff_proposal', { proposal: { id: 'handoff-1' } }),
      proposalEvent('handoff_proposal_resolved', { proposalId: 'handoff-1', accepted: false }),
    ]) {
      expect(payloadToLegacyEvents(payload)).toEqual([])
    }
  })

  test('运行时事件仍正常投影，卡片事件的排除不影响其它分支', () => {
    const payload = proposalEvent('permission_resolved', { requestId: 'req-1', behavior: 'allow' })
    expect(payloadToLegacyEvents(payload)).toEqual([
      { type: 'permission_resolved', requestId: 'req-1', behavior: 'allow' },
    ])
  })
})
