import { describe, expect, test } from 'bun:test'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { compactCompletedBackgroundStreamState } from './agent-stream-state-cleanup'

function state(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return { running: false, content: 'partial output', toolActivities: [{ toolUseId: 'tool-1', toolName: 'Read', input: {}, done: false }], ...overrides }
}

describe('compactCompletedBackgroundStreamState', () => {
  test('Given a completed background state without usage When compacting Then removes it', () => {
    expect(compactCompletedBackgroundStreamState(state())).toBeUndefined()
  })

  test('Given a completed background state with usage When compacting Then preserves only context display data', () => {
    expect(compactCompletedBackgroundStreamState(state({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
      contextWindow: 200000,
      model: 'test-model',
    }))).toEqual({
      running: false,
      content: '',
      toolActivities: [],
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
      contextWindow: 200000,
      model: 'test-model',
    })
  })

  test('Given an active or soft-idle state When compacting Then leaves it untouched', () => {
    const running = state({ running: true })
    const waiting = state({ backgroundWaiting: true })

    expect(compactCompletedBackgroundStreamState(running)).toBe(running)
    expect(compactCompletedBackgroundStreamState(waiting)).toBe(waiting)
  })
})
