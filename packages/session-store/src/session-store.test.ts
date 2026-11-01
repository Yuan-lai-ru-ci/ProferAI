import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionIndexStore } from './index-store'
import { createSessionMessageStore } from './message-store'
import { createSessionStorePaths, sessionGraphPath, sessionHarnessPath, sessionMessagesPath } from './paths'
import type { AgentSessionsIndex } from './contracts'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

async function setup(): Promise<ReturnType<typeof createSessionStorePaths>> {
  root = await mkdtemp(join(tmpdir(), 'profer-session-store-'))
  return createSessionStorePaths(root)
}

function meta(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: id, createdAt: 1, updatedAt: 1, ...overrides } as AgentSessionsIndex['sessions'][number]
}

describe('session-store paths', () => {
  test('uses existing Profer data layout by default', async () => {
    const paths = await setup()
    expect(paths.sessionsIndex).toBe(join(root, 'agent-sessions.json'))
    expect(sessionMessagesPath(paths, 's1')).toBe(join(root, 'agent-sessions', 's1.jsonl'))
    expect(sessionGraphPath(paths, 's1')).toBe(join(root, 'agent-sessions', 's1-graph.jsonl'))
    expect(sessionHarnessPath(paths, 's1')).toBe(join(root, 'agent-sessions', 's1-pi-harness.jsonl'))
  })
})

describe('session index store', () => {
  test('recovers backup, normalizes legacy runtime and filters archived entries', async () => {
    const paths = await setup()
    await mkdir(paths.configDir, { recursive: true })
    const data: AgentSessionsIndex = {
      version: 1,
      sessions: [meta('live', { updatedAt: 2 }), meta('old', { archived: true, agentRuntime: 'legacy' })],
    }
    await writeFile(`${paths.sessionsIndex}.bak`, JSON.stringify(data))
    const store = createSessionIndexStore(paths)

    expect((await store.list()).map((session) => session.id)).toEqual(['live'])
    expect((await store.list(true)).map((session) => session.agentRuntime)).toEqual(['claude', 'claude'])
    expect((await store.get('old'))?.agentRuntime).toBe('claude')
    expect(JSON.parse(await readFile(paths.sessionsIndex, 'utf8')).sessions).toHaveLength(2)
  })

  test('serializes concurrent writes and returns current data', async () => {
    const paths = await setup()
    const store = createSessionIndexStore(paths)
    await Promise.all([
      store.write({ version: 1, sessions: [meta('a')] }),
      store.write({ version: 1, sessions: [meta('b')] }),
    ])
    expect((await store.read()).sessions).toHaveLength(1)
    expect((await store.get('b'))?.id).toBe('b')
  })
})

describe('session message store', () => {
  test('provenance is retained across append, pagination and reload', async () => {
    const paths = await setup()
    const store = createSessionMessageStore(paths)
    const provenance = { schemaVersion: 1, messageId: 'u1', author: { type: 'agent', id: 'worker' }, runId: 'run-1', taskId: 'task-1', triggerId: 'trigger-1' }
    await store.append('s1', [{
      type: 'user', uuid: 'sdk-u1', _provenance: provenance,
      message: { content: [{ type: 'text', text: 'handoff' }] },
    } as never])
    const page = await store.readPage('s1', { tail: 1 })
    expect(page.messages[0]).toMatchObject({ uuid: 'sdk-u1', _provenance: provenance })
    expect((await store.read('s1'))[0]).toMatchObject({ uuid: 'sdk-u1', _provenance: provenance })
  })

  test('appends, pages, replaces and clears JSONL while tolerating malformed lines', async () => {
    const paths = await setup()
    const store = createSessionMessageStore(paths)
    await store.append('s1', [
      { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'one' }] } } as never,
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'two' }] } } as never,
    ])
    await writeFile(sessionMessagesPath(paths, 's1'), `broken-json\n${await readFile(sessionMessagesPath(paths, 's1'), 'utf8')}`, 'utf8')

    const page = await store.readPage('s1', { tail: 1 })
    expect(page.total).toBe(3)
    expect(page.messages.map((message) => (message as { uuid?: string }).uuid)).toEqual(['a1'])
    expect((await store.read('s1')).map((message) => (message as { uuid?: string }).uuid)).toEqual(['u1', 'a1'])

    await store.replace('s1', [{ type: 'user', uuid: 'u2' } as never])
    expect((await store.read('s1')).map((message) => (message as { uuid?: string }).uuid)).toEqual(['u2'])
    await store.clear('s1')
    expect(await store.read('s1')).toEqual([])
  })
})
