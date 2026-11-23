import { describe, expect, test } from 'bun:test'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { applyCoreRunStarted, compactCompletedBackgroundStreamState, isCurrentAgentStreamCompletion, rollbackRejectedAgentRunState, settleCompletedAgentStreamState } from './agent-stream-state-cleanup'

function state(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return { running: false, content: 'partial output', toolActivities: [{ toolUseId: 'tool-1', toolName: 'Read', input: {}, done: false }], ...overrides }
}

test('旁观端只凭 Core 开始事件点亮，迟到终态和重复开始不污染新旧轮次', () => {
  const event = { runId: 'core-run-2', startedAt: 100, modelId: 'core-model' }
  const running = applyCoreRunStarted(state({ runId: 'core-run-1', startedAt: 80, stopping: true }), event)!
  expect(running).toEqual({ runId: event.runId, startedAt: event.startedAt, model: 'core-model', running: true, content: '', toolActivities: [] })
  expect(isCurrentAgentStreamCompletion(running, { runId: 'core-run-1', startedAt: 200 })).toBe(false)
  expect(isCurrentAgentStreamCompletion(running, { runId: 'core-run-2', startedAt: 105 })).toBe(true)
  const settled = settleCompletedAgentStreamState(running, false)
  expect(applyCoreRunStarted(settled, event)).toBe(settled)
  expect(applyCoreRunStarted(running, { runId: 'core-run-1', startedAt: 80 })).toBe(running)
})

test('发起设备收到同轮开始事件时保留乐观状态与已到的流式输出', () => {
  const current = state({ running: true, startedAt: 120, stopping: true })
  const running = applyCoreRunStarted(current, { runId: 'run', startedAt: 120 })
  expect(running).toEqual({ ...current, runId: 'run', model: undefined })
})

describe('rollbackRejectedAgentRunState', () => {
  test('Given an optimistic compact is rejected before an Agent run starts When rolling back Then no input lock remains', () => {
    expect(rollbackRejectedAgentRunState(state({
      running: true,
      backgroundWaiting: true,
      stopping: true,
      isCompacting: true,
      compactInFlight: true,
    }))).toMatchObject({
      running: false,
      backgroundWaiting: false,
      stopping: false,
      isCompacting: false,
      compactInFlight: false,
    })
  })
})

describe('settleCompletedAgentStreamState', () => {
  test('Given a failed compact run When STREAM_COMPLETE arrives Then releases every input lock', () => {
    const unfinished = { toolUseId: 'tool-2', toolName: 'CompactContext', input: {}, done: false }
    expect(settleCompletedAgentStreamState(state({
      running: true,
      stopping: true,
      isCompacting: true,
      compactInFlight: true,
      backgroundWaiting: true,
      toolActivities: [unfinished],
    }), false)).toMatchObject({
      running: false,
      stopping: false,
      isCompacting: false,
      compactInFlight: false,
      backgroundWaiting: false,
      toolActivities: [{ ...unfinished, done: true }],
    })
  })

  test('Given background tasks remain When STREAM_COMPLETE arrives Then keeps only the soft-idle channel state', () => {
    expect(settleCompletedAgentStreamState(state({
      running: true,
      isCompacting: true,
      compactInFlight: true,
    }), true)).toMatchObject({
      running: false,
      backgroundWaiting: true,
      isCompacting: false,
      compactInFlight: false,
    })
  })
})

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
      usageUpdatedAt: 100,
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
      usageUpdatedAt: 100,
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
