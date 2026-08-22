import { describe, expect, test } from 'bun:test'
import type { TaskNode } from '@profer/project-core'
import { evaluateVerification } from './verification-evaluator'
import type { ToolFact } from './types'

const task: TaskNode = {
  id: 'task', subject: 'task', status: 'completed', description: '@verify: bun test target', dependsOn: [], dependedBy: [],
  artifact: ['dist/output.txt'], reviewStatus: 'none', createdAt: 1, updatedAt: 1,
}

function fact(id: string, kind: ToolFact['kind'], outcome: ToolFact['outcome'], timestamp: number, subject: Record<string, unknown> = {}): ToolFact {
  return { id, goalId: 'goal', turnId: 'turn', taskId: 'task', kind, outcome, timestamp, toolName: kind, subject, summary: id, fingerprint: id }
}

describe('Pi Harness verification evaluator', () => {
  test('verifies only when post-mutation artifact readback and explicit test evidence both exist', () => {
    const decision = evaluateVerification({
      task,
      facts: [
        fact('write', 'file_mutation', 'success', 10, { path: 'dist/output.txt' }),
        fact('read', 'file_read', 'success', 11, { path: 'dist/output.txt' }),
        fact('test', 'verification_command', 'success', 12, { category: 'test', exitCode: 0 }),
      ],
    })
    expect(decision).toMatchObject({ state: 'verified', evidenceFactIds: ['read', 'test'] })
  })

  test('invalidates an earlier verification when a later mutation has no new readback/test evidence', () => {
    const decision = evaluateVerification({
      task,
      facts: [
        fact('read-old', 'file_read', 'success', 10, { path: 'dist/output.txt' }),
        fact('test-old', 'verification_command', 'success', 11, { category: 'test', exitCode: 0 }),
        fact('write-new', 'file_mutation', 'success', 12, { path: 'dist/output.txt' }),
      ],
    })
    expect(decision).toMatchObject({ state: 'pending', reason: '缺少产物读回证据: dist/output.txt' })
  })

  test('marks a related verification failure as failed', () => {
    const decision = evaluateVerification({ task, facts: [fact('test-failed', 'verification_command', 'failure', 10, { category: 'test', exitCode: 1 })] })
    expect(decision).toMatchObject({ state: 'failed', evidenceFactIds: ['test-failed'] })
  })

  test('preserves an explicit waived state instead of pretending it is verified', () => {
    const decision = evaluateVerification({ task, facts: [], previous: { taskId: 'task', state: 'waived', reason: '用户接受风险', evidenceFactIds: [], updatedAt: 1 } })
    expect(decision).toEqual({ taskId: 'task', state: 'waived', reason: '用户接受风险', evidenceFactIds: [] })
  })
})
