import { describe, expect, test } from 'bun:test'
import type { TaskGraph, TaskNode } from '@profer/project-core'
import { decideShadowGovernorCandidate } from './governor'
import type { PiHarnessGoal, ToolFact } from './types'

const goal: PiHarnessGoal = {
  id: 'goal', sessionId: 'session', activeTaskId: 'active', state: 'active', createdAt: 1, updatedAt: 1,
  policy: { governorMode: 'shadow', permissionMode: 'bypassPermissions', maxFocusChars: 1200 },
  autonomyUsage: { taskTransitions: 0, repairAttemptsByTask: {}, equivalentVerificationRuns: {} },
}
const active: TaskNode = { id: 'active', subject: 'active', description: '', status: 'in_progress', dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none', createdAt: 1, updatedAt: 1 }
const ready: TaskNode = { id: 'ready', subject: 'ready', description: '', status: 'pending', dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none', createdAt: 2, updatedAt: 2 }
const graph: TaskGraph = { nodes: { active, ready }, edges: [], forkEdges: [], updatedAt: 1 }
function failure(): ToolFact { return { id: 'failed-test', goalId: 'goal', turnId: 'turn', taskId: 'active', kind: 'verification_command', outcome: 'failure', timestamp: 10, toolName: 'Bash', subject: { category: 'test' }, summary: 'failed', fingerprint: 'failed' } }

describe('Pi Harness shadow governor', () => {
  test('records but never executes a required verification candidate in shadow mode', () => {
    const candidate = decideShadowGovernorCandidate({ graph, goal, assurance: { taskId: 'active', state: 'pending', reason: '缺少测试', evidenceFactIds: [], updatedAt: 1 }, facts: [], existingFingerprints: new Set() })
    expect(candidate).toMatchObject({ taskId: 'active', action: 'required_verification', blockedReason: 'shadow_mode' })
  })

  test('blocks duplicate no-change failed validation loops', () => {
    const candidate = decideShadowGovernorCandidate({ graph, goal, assurance: { taskId: 'active', state: 'failed', reason: '测试失败', evidenceFactIds: ['failed-test'], updatedAt: 1 }, facts: [failure()], existingFingerprints: new Set() })
    expect(candidate).toBeUndefined()
  })

  test('allows a shadow repair candidate only after a new mutation and deduplicates by fingerprint', () => {
    const mutation: ToolFact = { ...failure(), id: 'write', kind: 'file_mutation', outcome: 'success', timestamp: 11, subject: { path: 'src/a.ts' }, fingerprint: 'write' }
    const first = decideShadowGovernorCandidate({ graph, goal, assurance: { taskId: 'active', state: 'failed', reason: '测试失败', evidenceFactIds: ['failed-test'], updatedAt: 1 }, facts: [failure(), mutation], existingFingerprints: new Set() })!
    expect(first).toMatchObject({ blockedReason: 'shadow_mode' })
    const second = decideShadowGovernorCandidate({ graph, goal, assurance: { taskId: 'active', state: 'failed', reason: '测试失败', evidenceFactIds: ['failed-test'], updatedAt: 1 }, facts: [failure(), mutation], existingFingerprints: new Set([first.fingerprint]) })
    expect(second).toBeUndefined()
  })

  test('does not consume a transition; it only reports a ready-task candidate', () => {
    const candidate = decideShadowGovernorCandidate({ graph, goal, assurance: { taskId: 'active', state: 'verified', reason: 'ok', evidenceFactIds: [], updatedAt: 1 }, facts: [], existingFingerprints: new Set() })
    expect(candidate).toMatchObject({ taskId: 'ready', action: 'ready_task', blockedReason: 'shadow_mode' })
    expect(goal.autonomyUsage.taskTransitions).toBe(0)
  })
})
