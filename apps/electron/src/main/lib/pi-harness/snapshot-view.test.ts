import { describe, expect, test } from 'bun:test'
import { createEmptyPiHarnessSnapshot, type PiHarnessSnapshot } from './types'
import { toPiHarnessSnapshotView } from './snapshot-view'

function snapshot(): PiHarnessSnapshot {
  const value = createEmptyPiHarnessSnapshot('session')
  value.goals.goal = {
    id: 'goal', sessionId: 'session', activeTaskId: 'task', state: 'paused', createdAt: 1, updatedAt: 5,
    policy: { governorMode: 'shadow', permissionMode: 'bypassPermissions', maxFocusChars: 1200 },
    autonomyUsage: { taskTransitions: 0, repairAttemptsByTask: {}, equivalentVerificationRuns: {} },
  }
  value.goalPauseReasons.goal = 'user_stop'
  value.turns.turn = { id: 'turn', goalId: 'goal', activeTaskId: 'task', state: 'interrupted', startedAt: 2, endedAt: 4, endReason: 'user_stop', usage: { modelCalls: 1, inputTokens: 2, outputTokens: 3, retries: 0, compactions: 0, durationMs: 4 } }
  value.verificationByTask.task = { taskId: 'task', state: 'pending', reason: '缺少测试', evidenceFactIds: ['secret-fact-id'], updatedAt: 3 }
  value.facts.fact = { id: 'fact', goalId: 'goal', turnId: 'turn', taskId: 'task', kind: 'command', timestamp: 3, toolName: 'Bash', outcome: 'success', subject: { commandHash: 'secret-command-hash' }, summary: 'Bash test success', fingerprint: 'secret-fingerprint' }
  value.governorCandidates.push({ eventId: 'internal-event', goalId: 'goal', taskId: 'task', timestamp: 5, action: 'required_verification', reason: '缺少测试', blockedReason: 'shadow_mode', estimatedPromptChars: 240, fingerprint: 'internal-fingerprint' })
  return value
}

describe('Pi Harness snapshot view', () => {
  test('projects execution, assurance, pause and shadow state without internal ledger fields', () => {
    const view = toPiHarnessSnapshotView(snapshot())
    expect(view).toMatchObject({
      sessionId: 'session',
      goal: { state: 'paused', activeTaskId: 'task', pauseReason: 'user_stop' },
      tasks: {
        task: {
          assurance: { state: 'pending', reason: '缺少测试' },
          execution: { state: 'interrupted', endReason: 'user_stop', modelCalls: 1 },
          lastFactSummary: 'Bash test success',
          shadowCandidate: { action: 'required_verification', blockedReason: 'shadow_mode' },
        },
      },
    })
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('secret-command-hash')
    expect(serialized).not.toContain('secret-fingerprint')
    expect(serialized).not.toContain('internal-event')
    expect(serialized).not.toContain('evidenceFactIds')
  })
})
