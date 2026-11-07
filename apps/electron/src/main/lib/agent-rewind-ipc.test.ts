import { afterEach, describe, expect, test } from 'bun:test'
import type { RewindPlan, RewindService } from '@profer/shared'
import { executeAgentRewind, legacyConversationRewind, prepareAgentRewind, setAgentRewindService, submitAgentAfterRewind, undoAgentRewind } from './agent-rewind-gateway'

const plan = {
  protocolVersion: 1,
  planId: 'p1',
  sessionId: 's1',
  mode: 'conversation',
  target: { kind: 'session-start' },
  runtime: 'claude',
  createdAt: 1,
  revision: { session: 1, files: 1, state: 1 },
  capability: { runtime: 'claude', supportsConversation: true, supportsFiles: false, supportsBoth: false, supportsUndo: true, supportsRefine: true, supportsSubmission: true },
} as RewindPlan

afterEach(() => setAgentRewindService(null))

function setup(overrides: Partial<RewindService> = {}) {
  const calls: string[] = []
  const service: RewindService = {
    async prepare(input) { calls.push(`prepare:${input.mode}`); return { plan: { ...plan, sessionId: input.sessionId } } },
    async refine() { return { plan } },
    async execute(input) { calls.push('execute'); return { status: 'committed', sessionId: input.sessionId, planId: input.planId, revision: plan.revision, mode: 'conversation' } },
    async undo(input) { calls.push(`undo:${input.sessionId}`); return { status: 'committed', sessionId: input.sessionId, planId: 'p1', revision: plan.revision, mode: 'conversation' } },
    async submitAfterRewind(input) { calls.push(`submit:${input.submissionId}`); return { status: 'dispatch-unknown', planId: input.planId, submissionId: input.submissionId } },
    ...overrides,
  }
  setAgentRewindService(service)
  return calls
}

describe('agent rewind IPC gateway', () => {
  test('legacy request becomes conversation and never selects file recovery', async () => {
    const calls = setup()
    await legacyConversationRewind({ sessionId: 's1' }, { kind: 'desktop' })
    expect(calls).toEqual(['prepare:conversation', 'execute'])
  })

  test('plan binding rejects cross-session and cross-caller execution', async () => {
    setup()
    await expect(prepareAgentRewind({ sessionId: 's1', mode: 'files', target: { kind: 'session-start' } }, { kind: 'remote', id: 'device-a' })).rejects.toThrow('未获服务端授权')
    setAgentRewindService({
      async prepare(input) { return { plan: { ...plan, sessionId: input.sessionId, mode: input.mode } } },
      async refine() { return { plan } },
      async execute(input) { return { status: 'committed', sessionId: input.sessionId, planId: input.planId, revision: plan.revision, mode: 'files' } },
      async undo() { return { status: 'failed', sessionId: 's1', planId: 'p1', revision: plan.revision, mode: 'files' } },
      async submitAfterRewind(input) { return { status: 'accepted', submissionId: input.submissionId, planId: input.planId } },
    }, { authorizeRemoteFiles: (sessionId, callerId) => sessionId === 's1' && callerId === 'device-a' })
    const prepared = await prepareAgentRewind({ sessionId: 's1', mode: 'files', target: { kind: 'session-start' } }, { kind: 'remote', id: 'device-a' })
    await expect(executeAgentRewind({ sessionId: 's2', planId: prepared.plan.planId, expectedRevision: plan.revision }, { kind: 'remote', id: 'device-a' })).rejects.toThrow()
    await expect(executeAgentRewind({ sessionId: 's1', planId: prepared.plan.planId, expectedRevision: plan.revision }, { kind: 'remote', id: 'device-b' })).rejects.toThrow()
  })

  test('submission retries are idempotent and preserve dispatch-unknown', async () => {
    const calls = setup()
    await prepareAgentRewind({ sessionId: 's1', mode: 'conversation', target: { kind: 'session-start' } }, { kind: 'desktop' })
    const input = { sessionId: 's1', planId: 'p1', requestId: 'r1', submissionId: 'sub1', draftId: 'd1' }
    const first = await submitAgentAfterRewind(input, { kind: 'desktop' })
    const retry = await submitAgentAfterRewind(input, { kind: 'desktop' })
    expect(first.status).toBe('dispatch-unknown')
    expect(retry).toEqual(first)
    expect(calls.filter(call => call.startsWith('submit:'))).toHaveLength(1)
    await expect(submitAgentAfterRewind({ ...input, draftId: 'different' }, { kind: 'desktop' })).rejects.toThrow()
  })

  test('undo recovery identifiers cannot cross sessions', async () => {
    setup({ async execute(input) { return { status: 'committed', sessionId: input.sessionId, planId: input.planId, recoveryId: 'rec1', revision: plan.revision, mode: 'conversation' } } })
    await prepareAgentRewind({ sessionId: 's1', mode: 'conversation', target: { kind: 'session-start' } }, { kind: 'desktop' })
    await executeAgentRewind({ sessionId: 's1', planId: 'p1', expectedRevision: plan.revision }, { kind: 'desktop' })
    await expect(undoAgentRewind({ sessionId: 's2', recoveryId: 'rec1' }, { kind: 'desktop' })).rejects.toThrow()
  })
})
