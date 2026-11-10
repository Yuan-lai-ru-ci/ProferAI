import { describe, expect, test } from 'bun:test'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { AgentStreamRestoreGate } from '@/lib/agent-stream-restore-gate'
import { decideRestoreMerge } from '@/lib/agent-stream-restore-merge'
import {
  isCurrentAgentStreamCompletion,
  settleCompletedAgentStreamState,
} from '@/lib/agent-stream-state-cleanup'

function running(startedAt = 1000): AgentStreamState {
  return { running: true, content: 'partial', toolActivities: [], startedAt } as AgentStreamState
}

function settled(startedAt = 1000): AgentStreamState {
  return settleCompletedAgentStreamState(running(startedAt), false)
}

const completedReplay = { active: false, hasTerminalEvent: true }

describe('decideRestoreMerge', () => {
  test('Given 本轮刚在本窗口结束（已收敛）When 60s 内切回会话 Then 不写 running 占位（回归：永久 spinner）', () => {
    expect(decideRestoreMerge(settled(), completedReplay)).toBe('keep')
  })

  test('Given 本窗口没有该会话状态 When 恢复带终态的快照 Then 写占位，等闸门放行终态收敛', () => {
    expect(decideRestoreMerge(undefined, completedReplay)).toBe('placeholder')
  })

  test('Given 主进程说仍在跑 When 本窗口无状态 Then 写占位', () => {
    expect(decideRestoreMerge(undefined, { active: true, hasTerminalEvent: false })).toBe('placeholder')
  })

  test('Given 主进程说仍在跑 When 本窗口已收敛 Then 写占位', () => {
    expect(decideRestoreMerge(settled(), { active: true, hasTerminalEvent: false })).toBe('placeholder')
  })

  test('Given 本窗口已在运行 When 恢复快照 Then 保持不动', () => {
    expect(decideRestoreMerge(running(), { active: true, hasTerminalEvent: false })).toBe('keep')
    expect(decideRestoreMerge(running(), completedReplay)).toBe('keep')
    expect(
      decideRestoreMerge({ ...settled(), backgroundWaiting: true } as AgentStreamState, completedReplay),
    ).toBe('keep')
  })

  test('Given 停止请求挂起 When 终态回放到已结束 run Then 收敛而不是保留停止态', () => {
    expect(decideRestoreMerge({ ...settled(), stopping: true } as AgentStreamState, completedReplay)).toBe('settle')
  })

  test('Given 主进程确认没有活跃 run 且无终态 When 本窗口还停在运行/停止 Then 收敛', () => {
    expect(decideRestoreMerge(running(), { active: false, hasTerminalEvent: false })).toBe('settle')
    expect(decideRestoreMerge({ ...settled(), stopping: true } as AgentStreamState, { active: false, hasTerminalEvent: false })).toBe('settle')
  })

  test('Given 主进程确认没有活跃 run 且无终态 When 本窗口已空闲 Then 保持不动', () => {
    expect(decideRestoreMerge(settled(), { active: false, hasTerminalEvent: false })).toBe('keep')
    expect(decideRestoreMerge(undefined, { active: false, hasTerminalEvent: false })).toBe('keep')
  })

  test('Given 旧版字符串快照 When 恢复 Then 按活跃流处理', () => {
    expect(decideRestoreMerge(undefined, 'legacy-session')).toBe('placeholder')
    expect(decideRestoreMerge(settled(), 'legacy-session')).toBe('placeholder')
  })
})

describe('恢复时序（闸门 + 合并规则）', () => {
  /** 复刻 useGlobalAgentListeners 的恢复流程：回放终态 → 应用快照 → 放行闸门。 */
  function restore(
    store: Map<string, AgentStreamState>,
    snapshot: { sessionId: string; active: boolean; hasTerminalEvent: boolean },
  ): void {
    const gate = new AgentStreamRestoreGate((sessionId) => store.get(sessionId) !== undefined)
    const release = gate.begin()

    const handleStreamComplete = (completion: { sessionId: string; startedAt?: number }): void => {
      const current = store.get(completion.sessionId)
      if (!isCurrentAgentStreamCompletion(current, completion)) return
      store.set(completion.sessionId, settleCompletedAgentStreamState(current, false))
    }
    const deferred = gate.defer(snapshot.sessionId, () => handleStreamComplete({ sessionId: snapshot.sessionId, startedAt: 1000 }))
    if (!deferred) handleStreamComplete({ sessionId: snapshot.sessionId, startedAt: 1000 })

    const current = store.get(snapshot.sessionId)
    const action = decideRestoreMerge(current, snapshot)
    if (action === 'settle' && current) store.set(snapshot.sessionId, settleCompletedAgentStreamState(current, false))
    if (action === 'placeholder') {
      store.set(snapshot.sessionId, { running: true, content: '', toolActivities: [], startedAt: undefined } as AgentStreamState)
    }

    release()
  }

  test('Given 刚结束的会话 When 立刻切回 Then 状态保持收敛，不再残留 spinner', () => {
    const store = new Map<string, AgentStreamState>([['s1', settled()]])
    restore(store, { sessionId: 's1', active: false, hasTerminalEvent: true })
    expect(store.get('s1')?.running).toBe(false)
  })

  test('Given 刷新后首次恢复 When 回放已结束 run 的终态 Then 占位被终态收敛', () => {
    const store = new Map<string, AgentStreamState>()
    restore(store, { sessionId: 's1', active: false, hasTerminalEvent: true })
    expect(store.get('s1')?.running).toBe(false)
  })
})
