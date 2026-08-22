import { describe, expect, test } from 'bun:test'
import type { TaskGraph, TaskNode } from '@profer/project-core'
import { replayPiHarnessEvents } from './pi-harness-reducer'
import { collectPiHarnessTelemetry, serializePiHarnessTelemetry } from './telemetry'
import type { PiHarnessEvent } from './types'

const task: TaskNode = {
  id: 'task', subject: '任务', description: '@verify: bun test target', status: 'in_progress',
  dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none', createdAt: 1, updatedAt: 1,
}
const graph: TaskGraph = { nodes: { task }, edges: [], forkEdges: [], updatedAt: 1 }
const policy = { governorMode: 'shadow' as const, permissionMode: 'bypassPermissions' as const, maxFocusChars: 1200 }

function event(overrides: Partial<PiHarnessEvent> = {}): PiHarnessEvent {
  return {
    version: 1, eventId: 'goal', timestamp: 1, sessionId: 'session', goalId: 'goal',
    type: 'goal_created', payload: { activeTaskId: 'task', policy },
    ...overrides,
  } as PiHarnessEvent
}

describe('Pi Harness telemetry', () => {
  test('attributes model/token/cost usage to the owning Goal without exposing facts', () => {
    const events: PiHarnessEvent[] = [
      event(),
      event({ eventId: 'turn', timestamp: 2, type: 'turn_started', turnId: 'turn', payload: { activeTaskId: 'task' } }),
      event({ eventId: 'settled', timestamp: 3, type: 'turn_state_changed', turnId: 'turn', payload: { state: 'settled', usage: { modelCalls: 2, inputTokens: 20, outputTokens: 10, retries: 1, compactions: 1, durationMs: 40 } } }),
      event({ eventId: 'cost', timestamp: 4, taskId: 'task', type: 'autonomy_budget_consumed', payload: { kind: 'verification_run', estimatedCostUsd: 0.12 } }),
    ]
    const telemetry = collectPiHarnessTelemetry({ snapshot: replayPiHarnessEvents('session', events), graph, events })

    expect(telemetry.usage).toMatchObject({ modelCalls: 2, inputTokens: 20, outputTokens: 10, retries: 1, compactions: 1, estimatedCostUsd: 0.12 })
    expect(telemetry.byGoal.goal).toMatchObject({ modelCalls: 2, equivalentVerificationRuns: 1, estimatedCostUsd: 0.12 })
    expect(serializePiHarnessTelemetry(telemetry)).not.toContain('commandHash')
  })

  test('detects stale verified assurance and no-change failed-loop blocking facts', () => {
    const failedFact = {
      id: 'failure', goalId: 'goal', turnId: 'turn', taskId: 'task', kind: 'verification_command', timestamp: 3,
      toolName: 'Bash', outcome: 'failure' as const, subject: { category: 'test' }, summary: 'failed', fingerprint: 'failure',
    }
    const events: PiHarnessEvent[] = [
      event(),
      event({ eventId: 'turn', timestamp: 2, type: 'turn_started', turnId: 'turn', payload: { activeTaskId: 'task' } }),
      event({ eventId: 'fact', timestamp: 3, type: 'tool_fact_recorded', turnId: 'turn', payload: { fact: failedFact } }),
      event({ eventId: 'failed', timestamp: 4, taskId: 'task', type: 'verification_state_changed', payload: { state: 'failed', reason: '测试失败', evidenceFactIds: ['failure'] } }),
    ]
    const telemetry = collectPiHarnessTelemetry({ snapshot: replayPiHarnessEvents('session', events), graph, events })
    expect(telemetry.safety).toMatchObject({ blockedNoChangeFailedVerificationLoops: 1, duplicateNoChangeFailedVerificationCandidates: 0 })

    const staleVerified = replayPiHarnessEvents('session', [
      ...events.filter((item) => item.type !== 'verification_state_changed'),
      event({ eventId: 'stale', timestamp: 5, taskId: 'task', type: 'verification_state_changed', payload: { state: 'verified', reason: 'claimed', evidenceFactIds: [] } }),
    ])
    expect(collectPiHarnessTelemetry({ snapshot: staleVerified, graph, events }).verification.falseVerified).toBe(1)
  })

  test('flags any turn created after a pause for manual audit rather than treating it as automatic success', () => {
    const events: PiHarnessEvent[] = [
      event(),
      event({ eventId: 'pause', timestamp: 2, type: 'goal_paused', payload: { reason: 'user_stop' } }),
      event({ eventId: 'later-turn', timestamp: 3, type: 'turn_started', turnId: 'turn-2', payload: { activeTaskId: 'task' } }),
    ]
    const telemetry = collectPiHarnessTelemetry({ snapshot: replayPiHarnessEvents('session', events), graph, events })
    expect(telemetry.safety).toMatchObject({ pauses: 1, turnsStartedAfterPause: 1 })
  })
})
