import { afterEach, describe, expect, test } from 'bun:test'
import type { RewindService } from '@profer/shared'
import { legacyConversationRewind, prepareAgentRewind, setAgentRewindService } from './agent-rewind-gateway'

afterEach(() => setAgentRewindService(null))

function createService(calls: string[]): RewindService {
  return {
    async prepare(input) {
      calls.push(`prepare:${input.mode}:${input.sessionId}`)
      return {
        plan: {
          protocolVersion: 1,
          planId: 'remote-plan',
          sessionId: input.sessionId,
          mode: input.mode,
          target: input.target,
          runtime: 'pi',
          createdAt: 1,
          revision: { session: 1, files: 1, state: 1 },
          capability: { runtime: 'pi', supportsConversation: true, supportsFiles: true, supportsBoth: true, supportsUndo: true, supportsRefine: true, supportsSubmission: true },
        },
      }
    },
    async refine() { throw new Error('unused') },
    async execute(input) { calls.push(`execute:${input.sessionId}`); return { status: 'committed', sessionId: input.sessionId, planId: input.planId, revision: { session: 1, files: 1, state: 2 }, mode: 'conversation' } },
    async undo() { throw new Error('unused') },
    async submitAfterRewind() { throw new Error('unused') },
  }
}

describe('agent rewind remote protocol boundary', () => {
  test('legacy remote request safely maps to conversation for its connection', async () => {
    const calls: string[] = []
    setAgentRewindService(createService(calls))
    const caller = { kind: 'remote' as const, id: 'authenticated-device-a' }
    await legacyConversationRewind({ sessionId: 'session-a', assistantMessageUuid: 'message-a' }, caller)
    expect(calls).toEqual(['prepare:conversation:session-a', 'execute:session-a'])
  })

  test('remote files require server-side caller/session authorization', async () => {
    const calls: string[] = []
    setAgentRewindService(createService(calls))
    await expect(prepareAgentRewind({ sessionId: 'session-a', mode: 'files', target: { kind: 'session-start' } }, { kind: 'remote', id: 'device-a' })).rejects.toThrow('未获服务端授权')
    setAgentRewindService(createService(calls), { authorizeRemoteFiles: (sessionId, callerId) => sessionId === 'session-a' && callerId === 'device-a' })
    await prepareAgentRewind({ sessionId: 'session-a', mode: 'files', target: { kind: 'session-start' } }, { kind: 'remote', id: 'device-a' })
    expect(calls).toEqual(['prepare:files:session-a'])
  })

  test('plans cannot be transferred between authenticated remote connections', async () => {
    const calls: string[] = []
    setAgentRewindService(createService(calls))
    await prepareAgentRewind({ sessionId: 'session-a', mode: 'conversation', target: { kind: 'session-start' } }, { kind: 'remote', id: 'device-a' })
    const { executeAgentRewind } = await import('./agent-rewind-gateway')
    await expect(executeAgentRewind({ sessionId: 'session-a', planId: 'remote-plan', expectedRevision: { session: 1, files: 1, state: 1 } }, { kind: 'remote', id: 'device-b' })).rejects.toThrow()
  })
})
