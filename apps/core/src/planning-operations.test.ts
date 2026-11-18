import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'profer-core-planning-'))
  const config = { host: '127.0.0.1', port: 0, configDir: dir, workspaceRoot: join(dir, 'workspaces'), mockAgent: true }
  const runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'planning-test', runtime, apiKey: 'isolated-test' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as AddressInfo).port
  return {
    runtime, config,
    async call(operation: string, args: unknown[] = [], authorized = true) {
      const response = await fetch(`http://127.0.0.1:${port}/planning/operations`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer isolated-test' } : {}) },
        body: JSON.stringify({ operation, args }),
      })
      return { status: response.status, body: await response.json() as { result?: unknown; error?: string } }
    },
    async close() { await closeCoreServer(server); runtime.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('Core-owned Planning protocol', () => {
  test('requires auth, isolates Core data, survives reopen and rejects stale updates', async () => {
    const first = await fixture(), second = await fixture()
    try {
      expect((await first.call('listTodos', [], false)).status).toBe(401)
      const workspace = first.runtime.workspaces.createManaged('first')
      first.runtime.createChannel({ id: 'planning-channel', name: 'fixture', provider: 'openai', apiKey: 'fixture', models: [] })
      const session = first.runtime.sessions.create({ title: 'Planning fixture', workspaceId: workspace.id })
      const created = await first.call('createTodo', [{ title: 'Core-only task', workspaceId: workspace.id, sessionId: session.id, reminders: [] }])
      expect(created.status).toBe(200)
      const todo = created.body.result as { id: string; updatedAt: number }
      expect((await second.call('listTodos')).body.result).toEqual([])
      expect((await second.call('createTodo', [{ title: 'Wrong Core', workspaceId: workspace.id }])).status).toBe(400)
      const started = await first.call('startTodoAgent', [{ todoId: todo.id, workspaceId: workspace.id, channelId: 'planning-channel', expectedUpdatedAt: todo.updatedAt }])
      expect(started.status).toBe(200)
      const result = started.body.result as { session: { id: string; workspaceId: string } }
      expect(first.runtime.sessions.getMeta(result.session.id)?.workspaceId).toBe(workspace.id)
      expect(second.runtime.sessions.getMeta(result.session.id)).toBeUndefined()
      expect((await first.call('updateTodo', [{ id: todo.id, expectedUpdatedAt: todo.updatedAt, status: 'completed' }])).status).toBe(200)
      expect((await first.call('updateTodo', [{ id: todo.id, expectedUpdatedAt: todo.updatedAt, title: 'stale' }])).status).toBe(409)
      const event = await first.call('createCalendarEvent', [{ title: 'Core event', startAt: 2000, reminders: [] }])
      expect(event.status).toBe(200)
      first.runtime.planning.closePlanningDatabase()
      const reopened = createCoreAgentRuntime(first.config)
      try {
        expect(reopened.planning.getTodo(todo.id)?.status).toBe('completed')
        expect(reopened.planning.listCalendarEvents()).toHaveLength(1)
        expect(second.runtime.planning.listCalendarEvents()).toEqual([])
      } finally { reopened.dispose() }
    } finally { await first.close(); await second.close() }
  })

  test('validates allowlist, input shape, groups and reminder arguments', async () => {
    const f = await fixture()
    try {
      expect((await f.call('createTodo', [{ title: 'x'.repeat(1024 * 1024) }])).status).toBe(413)
      for (const [operation, args] of [
        ['closePlanningDatabase', []], ['constructor', []], ['createTodo', [null]],
        ['createTodo', [{ title: 42 }]], ['listTodos', [{ status: 'bogus' }]],
        ['createCalendarEvent', [{ title: 'bad', startAt: -1 }]],
        ['listPlanningGroups', ['invalid']], ['snoozePlanningReminder', ['id', -2]],
      ] as Array<[string, unknown[]]>) expect((await f.call(operation, args)).status).toBe(400)
      const group = await f.call('createPlanningGroup', [{ scope: 'todo', name: 'Tasks' }])
      expect(group.status).toBe(200)
      expect((await f.call('listPlanningGroups', ['todo'])).body.result).toHaveLength(1)
      expect((await f.call('createPlanningTag', [{ name: 'tag' }])).status).toBe(200)
      expect((await f.call('listPlanningTags')).body.result).toHaveLength(1)
    } finally { await f.close() }
  })
})
