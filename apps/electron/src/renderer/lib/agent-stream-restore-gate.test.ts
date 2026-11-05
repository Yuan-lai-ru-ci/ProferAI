import { describe, expect, test } from 'bun:test'
import { AgentStreamRestoreGate, shouldCreateRestoreState } from '@/lib/agent-stream-restore-gate'

/** 模拟 renderer 的 agentStreamingStatesAtom：只有 key 存在才算「本会话已有流式状态」。 */
function streamStates(...sessionIds: string[]): (sessionId: string) => boolean {
  const known = new Set(sessionIds)
  return (sessionId) => known.has(sessionId)
}

describe('AgentStreamRestoreGate', () => {
  test('Given 刷新恢复尚未结束且本会话没有流式状态 When 终态到达 Then 暂存到恢复请求结束', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const dispatched: string[] = []
    const release = gate.begin()

    expect(gate.defer('s1', () => dispatched.push('complete'))).toBe(true)
    expect(dispatched).toEqual([])
    expect(gate.pendingCount).toBe(1)

    release()
    expect(dispatched).toEqual(['complete'])
  })

  test('Given 恢复期间已回放出流式状态 When 终态到达 Then 立即派发', () => {
    const gate = new AgentStreamRestoreGate(streamStates('s1'))
    const dispatched: string[] = []
    const release = gate.begin()

    // defer 返回 false 表示「请调用方立刻自行派发」，这里模拟专用 handler 的分支。
    const deferred = gate.defer('s1', () => dispatched.push('complete'))
    if (!deferred) dispatched.push('complete')

    expect(deferred).toBe(false)
    expect(dispatched).toEqual(['complete'])
    expect(gate.pendingCount).toBe(0)
    release()
  })

  test('Given 暂存了多个终态 When 恢复请求结束 Then 按原顺序派发且之后不再暂存', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const dispatched: string[] = []
    const release = gate.begin()
    const deliver = (sessionId: string, label: string): void => {
      if (!gate.defer(sessionId, () => dispatched.push(label))) dispatched.push(label)
    }

    deliver('s1', 'complete:s1')
    deliver('s2', 'error:s2')
    expect(dispatched).toEqual([])

    release()
    expect(dispatched).toEqual(['complete:s1', 'error:s2'])
    expect(gate.pendingCount).toBe(0)

    // 恢复请求结束后即使会话仍无状态也立即派发，不再堆积。
    deliver('s1', 'complete:s1:again')
    expect(dispatched).toEqual(['complete:s1', 'error:s2', 'complete:s1:again'])
    expect(gate.pendingCount).toBe(0)
  })

  test('Given release 被重复调用 When 派发 Then 不会重复执行已放行的终态', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const dispatched: string[] = []
    const release = gate.begin()

    gate.defer('s1', () => dispatched.push('complete'))
    release()
    release()
    expect(dispatched).toEqual(['complete'])
  })

  test('Given 并发恢复请求 When 其中一个先结束 Then 仍暂存终态直到最后一个请求结束', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const first = gate.begin()
    const second = gate.begin()
    const dispatched: string[] = []

    expect(gate.defer('s1', () => dispatched.push('complete'))).toBe(true)
    first()
    expect(dispatched).toEqual([])
    second()
    expect(dispatched).toEqual(['complete'])
  })

  test('Given 新 run 已写入状态 When 旧终态在恢复期间到达 Then 交给调用方竞态保护裁决', () => {
    const gate = new AgentStreamRestoreGate(streamStates('s1'))
    const dispatched: string[] = []
    const release = gate.begin()

    const deferred = gate.defer('s1', () => dispatched.push('stale-complete'))
    if (!deferred) dispatched.push('stale-complete')

    release()
    expect(dispatched).toEqual(['stale-complete'])
    expect(gate.pendingCount).toBe(0)
  })

  test('恢复快照只有活跃或包含待回放终态时才创建占位', () => {
    expect(shouldCreateRestoreState('legacy-session')).toBe(true)
    expect(shouldCreateRestoreState({ active: true, hasTerminalEvent: false })).toBe(true)
    expect(shouldCreateRestoreState({ active: false, hasTerminalEvent: true })).toBe(true)
    expect(shouldCreateRestoreState({ active: false, hasTerminalEvent: false })).toBe(false)
  })
})
