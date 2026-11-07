import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from './session-store'
import { createSessionStorePaths, sessionMessagesPath } from './paths'
import { createSessionOperationService } from './operations'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

function message(type: 'user' | 'assistant', uuid: string) {
  return { type, uuid, message: { content: [{ type: 'text', text: uuid }] } } as never
}

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'profer-session-operations-'))
  const paths = createSessionStorePaths(root)
  const store = createSessionStore(paths)
  const stopped: string[] = []
  const service = createSessionOperationService({
    store,
    host: {
      async getDeletionOrder(id) { return id === 'parent' ? ['child', id] : [id] },
      async stopAndWait(id) { stopped.push(id) },
    },
  })
  return { paths, store, service, stopped }
}

describe('session operation service', () => {
  test('fork copies only through the requested message and preserves source', async () => {
    const { store, service } = await setup()
    const source = await store.metadata.create({ title: 'source', agentRuntime: 'claude' })
    await store.messages.append(source.id, [message('user', 'u1'), message('assistant', 'a1'), message('user', 'u2')])

    const fork = await service.fork({ operationId: 'fork-1', sessionId: source.id, upToMessageUuid: 'a1' })

    expect(fork.title).toBe('source (fork)')
    expect((await store.messages.read(fork.id)).map((item) => (item as { uuid: string }).uuid)).toEqual(['u1', 'a1'])
    expect((await store.messages.read(source.id)).map((item) => (item as { uuid: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
  })

  test('rewind rejects an unknown message UUID without changing messages or native artifacts', async () => {
    const { store } = await setup()
    const session = await store.metadata.create({ title: 'keep', agentRuntime: 'claude' })
    await store.messages.append(session.id, [message('user', 'u1'), message('assistant', 'a1')])
    let nativeRewindCalls = 0
    const guardedService = createSessionOperationService({
      store,
      host: {
        async getDeletionOrder(id) { return [id] },
        async stopAndWait() {},
        getArtifactAdapter() {
          return {
            runtime: 'claude',
            async fork() { return {} },
            async rewind() { nativeRewindCalls += 1; return {} },
          }
        },
      },
    })

    await expect(guardedService.rewind({
      operationId: 'rewind-unknown',
      sessionId: session.id,
      assistantMessageUuid: 'missing',
    })).rejects.toMatchObject({ code: 'target_not_found' })

    expect((await store.messages.read(session.id)).map((item) => (item as { uuid: string }).uuid)).toEqual(['u1', 'a1'])
    expect(nativeRewindCalls).toBe(0)
  })

  test('fork failure rolls back destination metadata and copied files', async () => {
    const { paths, store } = await setup()
    const source = await store.metadata.create({ title: 'source', agentRuntime: 'claude' })
    await store.messages.append(source.id, [message('user', 'u1')])
    const service = createSessionOperationService({
      store,
      host: {
        async getDeletionOrder(id) { return [id] },
        async stopAndWait() {},
        getArtifactAdapter() {
          return {
            runtime: 'claude',
            async fork() { throw new Error('native fork failed') },
          }
        },
      },
    })

    await expect(service.fork({ operationId: 'fork-fail', sessionId: source.id })).rejects.toThrow('native fork failed')
    expect((await store.index.list(true)).map((item) => item.id)).toEqual([source.id])
    expect(await readFile(sessionMessagesPath(paths, source.id), 'utf8')).toContain('u1')
  })

  test('delete stops leaf-to-root before removing data and metadata', async () => {
    const { store, service, stopped } = await setup()
    const parent = await store.metadata.create({ title: 'parent', agentRuntime: 'claude' })
    const child = await store.metadata.create({ title: 'child', agentRuntime: 'pi' })
    await store.metadata.update(child.id, { parentSessionId: parent.id, sourceDelegationId: 'delegation' })
    await store.messages.append(parent.id, [message('user', 'parent-message')])
    await store.messages.append(child.id, [message('user', 'child-message')])

    const resultService = createSessionOperationService({
      store,
      host: {
        async getDeletionOrder() { return [child.id, parent.id] },
        async stopAndWait(id) { stopped.push(id) },
      },
    })
    const result = await resultService.delete({ operationId: 'delete-1', sessionId: parent.id })

    expect(stopped).toEqual([child.id, parent.id])
    expect(result.deletedSessionIds).toEqual([child.id, parent.id])
    expect(await store.index.list(true)).toEqual([])
    expect(await store.messages.read(parent.id)).toEqual([])
    expect(await store.messages.read(child.id)).toEqual([])
  })

  test('failed stop leaves all session data intact', async () => {
    const { store } = await setup()
    const session = await store.metadata.create({ title: 'keep', agentRuntime: 'claude' })
    await store.messages.append(session.id, [message('user', 'u1')])
    const service = createSessionOperationService({
      store,
      host: {
        async getDeletionOrder(id) { return [id] },
        async stopAndWait() { throw new Error('stop failed') },
      },
    })

    await expect(service.delete({ operationId: 'delete-fail', sessionId: session.id })).rejects.toThrow('stop failed')
    expect(await store.index.get(session.id)).toBeDefined()
    expect((await store.messages.read(session.id)).map((item) => (item as { uuid: string }).uuid)).toEqual(['u1'])
  })
})
