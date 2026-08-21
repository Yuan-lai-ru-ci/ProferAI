import { describe, expect, test } from 'bun:test'
import type { AgentStreamState } from './agent-atoms'
import { isCurrentAgentStreamCompletion, settleCompletedAgentStreamState } from '@/lib/agent-stream-state-cleanup'

function state(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    stopping: true,
    content: 'partial',
    startedAt: 200,
    toolActivities: [{ toolUseId: 'tool-1', toolName: 'Read', input: {}, done: false }],
    ...overrides,
  }
}

describe('Agent stream terminal completion', () => {
  test('Given a matching terminal event When completing Then clears running, stopping and unfinished tools', () => {
    const current = state()
    expect(isCurrentAgentStreamCompletion(current, { startedAt: 200 })).toBe(true)
    expect(settleCompletedAgentStreamState(current, false)).toMatchObject({
      running: false,
      stopping: false,
      backgroundWaiting: false,
      toolActivities: [{ done: true }],
    })
  })

  test('Given a completion from an older run When checking Then it cannot change the newer run', () => {
    expect(isCurrentAgentStreamCompletion(state({ startedAt: 300 }), { startedAt: 200 })).toBe(false)
  })

  test('Given a legacy completion without startedAt for a tracked run When checking Then it is ignored', () => {
    expect(isCurrentAgentStreamCompletion(state({ startedAt: 300 }), {})).toBe(false)
  })
})
