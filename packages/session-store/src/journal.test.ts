import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createSessionStore } from './session-store'
import { createSessionStorePaths } from './paths'
import { createSessionOperationService } from './operations'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

function message(type: 'user' | 'assistant', uuid: string, createdAt: number) {
  return { type, uuid, _createdAt: createdAt, message: { content: [{ type: 'text', text: uuid }] } } as never
}

test('fork operation persists a journal while running and removes it after commit', async () => {
  root = await mkdtemp(`${tmpdir()}/profer-journal-operation-`)
  const paths = createSessionStorePaths(root)
  const store = createSessionStore(paths)
  const source = await store.metadata.create({ title: 'source', agentRuntime: 'claude' })
  await store.messages.append(source.id, [message('user', 'u1', 10), message('assistant', 'a1', 20)])
  const progress: string[] = []
  const service = createSessionOperationService({
    store,
    journalDir: `${root}/journals`,
    host: {
      async getDeletionOrder(id) { return [id] },
      async stopAndWait() {},
    },
  })

  const fork = await service.fork({
    operationId: 'fork-journal',
    sessionId: source.id,
    upToMessageUuid: 'a1',
    onProgress: (event) => progress.push(event.phase),
  })

  expect(fork.title).toBe('source (fork)')
  expect(progress[0]).toBe('reading')
  expect(progress.at(-1)).toBe('completed')
  expect(progress.filter((phase) => phase === 'copying').length).toBeGreaterThan(0)
  await expect(store.index.get(fork.id)).resolves.toBeDefined()
  await expect(store.index.get(source.id)).resolves.toBeDefined()

  const journalStore = (await import('./journal')).createSessionJournalStore(`${root}/journals`)
  await journalStore.write({ operationId: 'durable', operation: 'rewind', sessionId: source.id, status: 'started', phase: 'applying', createdAt: 1, updatedAt: 1 })
  await expect(journalStore.read('durable')).resolves.toMatchObject({ phase: 'applying' })
  await expect(journalStore.list()).resolves.toHaveLength(1)
})
