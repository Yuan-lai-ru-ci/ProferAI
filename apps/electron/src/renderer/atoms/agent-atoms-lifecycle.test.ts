import { describe, expect, test } from 'bun:test'
import { applyAgentEvent, type AgentStreamState } from './agent-atoms'

function runningState(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    content: '',
    toolActivities: [],
    ...overrides,
  }
}

describe('Agent renderer lifecycle ownership', () => {
  test('Given an SDK error event When main ownership is not released Then keeps the renderer run active', () => {
    const current = runningState({ isCompacting: true, compactInFlight: true })

    expect(applyAgentEvent(current, {
      type: 'error',
      message: 'Upstream response stream was interrupted',
    })).toBe(current)
  })

  test('Given a typed error event When main ownership is not released Then only clears retry UI', () => {
    const next = applyAgentEvent(runningState({
      retrying: {
        currentAttempt: 2,
        maxAttempts: 8,
        history: [],
        failed: false,
      },
    }), {
      type: 'typed_error',
      error: {
        code: 'network_error',
        title: '网络异常',
        message: 'Upstream response stream was interrupted',
        actions: [],
        canRetry: true,
      },
    })

    expect(next.running).toBe(true)
    expect(next.retrying).toBeUndefined()
  })
})
