import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, RewindMode, RewindPlan } from '@profer/shared'
import { createSessionOperationService, createSessionStore, createSessionStorePaths } from '@profer/session-store'
import { createRewindFixture, fixtureMessageAtTarget, fixturePlan, fixtureTarget } from './agent-rewind-fixtures'

const runtimes: AgentRuntime[] = ['claude', 'pi']
let tempRoot = ''

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('agent rewind D0 product contract', () => {
  test('conversation plans never contain file actions and files plans never contain conversation actions', () => {
    for (const runtime of runtimes) {
      const target = fixtureTarget('after-t1')
      const conversation = fixturePlan(runtime, 'conversation', target)
      const files = fixturePlan(runtime, 'files', target)
      const both = fixturePlan(runtime, 'both', target)

      expect(conversation.files).toBeUndefined()
      expect(conversation.conversation).toBeDefined()
      expect(files.conversation).toBeUndefined()
      expect(files.files).toBeDefined()
      expect(both.conversation).toBeDefined()
      expect(both.files).toBeDefined()
      expect(conversation.capability.supportsFiles).toBeFalse()
    }
  })

  test('after T1 and before T2 resolve to the same B boundary for Claude and Pi', () => {
    for (const runtime of runtimes) {
      const fixture = createRewindFixture(runtime)
      const afterT1 = fixtureMessageAtTarget(fixture, fixtureTarget('after-t1'))
      const beforeT2 = fixtureMessageAtTarget(fixture, fixtureTarget('before-t2'))
      expect(afterT1).toEqual(beforeT2)
      expect(afterT1.at(-1)?.uuid).toBe('a-t1')
      expect(fixture.files[0]?.values.afterT1).toBe('B')
    }
  })

  test('tool intermediate messages remain inside their turn and do not become targets', () => {
    const fixture = createRewindFixture('claude')
    const target = fixtureTarget('after-t1')
    const kept = fixtureMessageAtTarget(fixture, target)
    expect(kept.map(message => message.uuid)).toEqual(['u-t1', 'tool-t1', 'a-t1'])
    expect(target).not.toEqual({ kind: 'message', messageUuid: 'tool-t1' })
  })

  test('first-turn failure has no terminal/file evidence and cannot claim file recovery', () => {
    const fixture = createRewindFixture('pi')
    expect(fixture.failedFirstTurn).toEqual({ turnId: 'T0', hasTerminalMessage: false, hasFileEvidence: false })
    const plan = fixturePlan('pi', 'conversation', { kind: 'session-start' })
    expect(plan.files).toBeUndefined()
    expect(plan.capability.supportsFiles).toBeFalse()
  })

  test('unknown target is represented as a deterministic rejection, never session-start', () => {
    const fixture = createRewindFixture('claude')
    const unknown = fixtureMessageAtTarget(fixture, { kind: 'message', messageUuid: 'missing-uuid' })
    expect(unknown).toEqual([])
    const plan = fixturePlan('claude', 'conversation', { kind: 'message', messageUuid: 'missing-uuid' })
    expect(plan.target).toEqual({ kind: 'message', messageUuid: 'missing-uuid' })
    expect(plan.target).not.toEqual({ kind: 'session-start' })
  })

  test('pagination boundary is explicit: unloaded page cannot be treated as an empty session', () => {
    const fixture = createRewindFixture('claude')
    const pageWindow = fixture.messages.slice(0, 3)
    const requestedUuid = 'a-t3'
    expect(pageWindow.some(message => message.uuid === requestedUuid)).toBeFalse()
    expect(fixtureMessageAtTarget({ ...fixture, messages: pageWindow }, { kind: 'message', messageUuid: requestedUuid })).toEqual([])
    expect(requestedUuid).not.toBe('')
  })

  test('legacy rewind rejects an unknown uuid instead of clearing the whole session', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'profer-rewind-contract-'))
    const store = createSessionStore(createSessionStorePaths(tempRoot))
    const session = await store.metadata.create({ title: 'fixture', agentRuntime: 'claude' })
    await store.messages.append(session.id, [
      { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'A' }] } } as never,
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'B' }] } } as never,
    ])
    const service = createSessionOperationService({
      store,
      host: { async getDeletionOrder(id) { return [id] }, async stopAndWait() {} },
    })

    await expect(service.rewind({ operationId: 'unknown-target', sessionId: session.id, assistantMessageUuid: 'missing-uuid' })).rejects.toMatchObject({ code: 'target_not_found' })
    expect((await store.messages.read(session.id)).map(message => (message as { uuid: string }).uuid)).toEqual(['u1', 'a1'])
  })

  test('all modes and target ids are serializable without dropping turnId/revision', () => {
    const modes: RewindMode[] = ['conversation', 'files', 'both']
    for (const runtime of runtimes) {
      for (const mode of modes) {
        const plan = fixturePlan(runtime, mode, fixtureTarget('before-t2'))
        const decoded = JSON.parse(JSON.stringify(plan)) as RewindPlan
        expect(decoded.mode).toBe(mode)
        expect(decoded.turnId).toBe('T2')
        expect(decoded.revision.state).toBe(3)
      }
    }
  })
})
