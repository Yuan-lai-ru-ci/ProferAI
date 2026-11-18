import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningStore, createPlanningAgentOperations } from '@profer/session-store'
import { injectClaudePlanningMcpServer } from '@profer/agent-provider-claude'
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import { loadPiPlanningToolDefinitions } from '@profer/agent-provider-pi'
import { openCorePlanningDatabase } from './planning-database'

describe('Core Planning tools', () => {
  test('Claude handlers use the same Core-owned operations and version checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-claude-planning-tools-'))
    const store = createPlanningStore({ databasePath: () => join(dir, 'planning.db'), openDatabase: openCorePlanningDatabase })
    const operations = createPlanningAgentOperations(store, { broadcastPlanningChanged() {}, broadcastPlanningAgentOperation() {} })
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    const sdk: Pick<typeof ClaudeSdk, 'tool' | 'createSdkMcpServer'> = {
      tool(name, description, schema, handler) {
        handlers.set(name, input => Reflect.apply(handler, undefined, [input, {}]))
        return { name, description, inputSchema: schema, handler }
      },
      createSdkMcpServer() { return { type: 'sdk', name: 'planning', instance: {} as ReturnType<typeof ClaudeSdk.createSdkMcpServer>['instance'] } },
    }
    try {
      await injectClaudePlanningMcpServer(sdk, {}, { sessionId: 'claude-session', workspaceId: 'claude-workspace' }, operations)
      expect(handlers.size).toBe(9)
      await handlers.get('create_todo')!({ title: 'Claude Core Todo', reminders: [] })
      const todo = store.listTodos()[0]!
      expect(todo).toMatchObject({ title: 'Claude Core Todo', workspaceId: 'claude-workspace', sessionLinks: [{ sessionId: 'claude-session' }] })
      const error = await handlers.get('update_todo')!({ id: todo.id, title: 'missing version' })
      expect(JSON.stringify(error)).toContain('expectedUpdatedAt')
      await handlers.get('update_todo')!({ id: todo.id, expectedUpdatedAt: todo.updatedAt, status: 'completed' })
      expect(store.getTodo(todo.id)?.status).toBe('completed')
    } finally { store.closePlanningDatabase(); rmSync(dir, { recursive: true, force: true }) }
  })

  test('executes real SQLite operations with bound session/workspace and cannot move another workspace data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-planning-tools-'))
    const store = createPlanningStore({ databasePath: () => join(dir, 'planning.db'), openDatabase: openCorePlanningDatabase })
    const operations = createPlanningAgentOperations(store, { broadcastPlanningChanged() {}, broadcastPlanningAgentOperation() {} })
    try {
      const ctx = { sessionId: 'session-a', workspaceId: 'workspace-a' }
      const tools = await loadPiPlanningToolDefinitions(ctx, operations)
      const create = tools.find(tool => tool.name === 'mcp__planning__create_todo')!
      const result = await Reflect.apply(create.execute, create, ['test-call', { title: 'Agent Core task', reminders: [] }, undefined, undefined, {}])
      expect(result.content).toHaveLength(1)
      const todo = store.listTodos()[0]!
      expect(todo.workspaceId).toBe(ctx.workspaceId)
      expect(todo.sessionLinks[0]?.sessionId).toBe(ctx.sessionId)
      const other = store.createTodo({ title: 'other', workspaceId: 'workspace-b', reminders: [] })
      await expect(operations.getPlanningTodo(ctx, other.id)).rejects.toThrow('不属于')
      await expect(operations.updatePlanningTodo(ctx, { id: other.id, expectedUpdatedAt: other.updatedAt, title: 'overwrite' })).rejects.toThrow('不属于')
      expect(await operations.listPlanningTodos({ sessionId: 'no-workspace' })).toEqual([])
      await operations.updatePlanningTodo(ctx, { id: todo.id, expectedUpdatedAt: todo.updatedAt, status: 'completed' })
      expect(store.getTodo(todo.id)?.status).toBe('completed')
      const foreign = store.createCalendarEvent({ title: 'other calendar', workspaceId: 'workspace-b', startAt: 1000, reminders: [] })
      const own = store.createCalendarEvent({ title: 'own calendar', workspaceId: ctx.workspaceId, startAt: 2000, reminders: [] })
      expect((await operations.listPlanningCalendarEvents(ctx, { limit: 1 })).map(event => event.id)).toEqual([own.id])
      await expect(operations.getPlanningCalendarEvent(ctx, foreign.id)).rejects.toThrow('不属于')
      await expect(operations.updatePlanningCalendarEvent(ctx, { id: own.id, title: 'missing version' })).rejects.toThrow('expectedUpdatedAt')
      const disabled = await loadPiPlanningToolDefinitions({ ...ctx, disabledTools: ['create_todo'] }, operations)
      expect(disabled.some(tool => tool.name === create.name)).toBe(false)
    } finally { store.closePlanningDatabase(); rmSync(dir, { recursive: true, force: true }) }
  })
})
