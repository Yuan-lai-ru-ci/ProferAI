import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningStore, type PlanningSqliteDatabase } from './planning-store'

type TestSqliteValue = string | number | bigint | boolean | Uint8Array | null

function createStore(path: string) {
  return createPlanningStore({
    databasePath: () => path,
    openDatabase(filename): PlanningSqliteDatabase {
      const db = new Database(filename)
      const statements: Array<{ finalize(): void }> = []
      return {
        exec: sql => { db.exec(sql) },
        close: () => { for (const statement of statements) statement.finalize(); db.close() },
        prepare(sql) {
          const statement = db.prepare<unknown, [Record<string, TestSqliteValue>]>(sql)
          statements.push(statement)
          const params = (input: Record<string, unknown> = {}): Record<string, TestSqliteValue> => Object.fromEntries(
            Object.entries(input).map(([key, value]) => {
              if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'boolean' && !(value instanceof Uint8Array)) throw new Error('SQLite测试参数类型无效')
              return [':' + key, value]
            }),
          )
          return {
            all: input => statement.all(params(input)),
            get: input => statement.get(params(input)),
            run: input => statement.run(params(input)),
          }
        },
      }
    },
  })
}

describe('host-neutral Planning store', () => {
  test('isolates Core-owned databases, persists and preserves optimistic conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-planning-store-'))
    const first = createStore(join(dir, 'first.db'))
    const second = createStore(join(dir, 'second.db'))
    try {
      const group = first.createPlanningGroup({ name: 'Tasks', scope: 'todo' })
      const tag = first.createPlanningTag({ name: 'isolated' })
      const todo = first.createTodo({ title: 'First Core only', workspaceId: 'first-workspace', groupId: group.id, tagIds: [tag.id], reminders: [], sessionId: 'first-session' })
      expect(second.listTodos()).toEqual([])
      expect(first.listTodos({ workspaceId: null })).toEqual([])
      const unbound = first.createTodo({ title: 'No workspace', reminders: [] })
      expect(first.listTodos({ workspaceId: null }).map(todo => todo.id)).toEqual([unbound.id])
      expect(second.listPlanningGroups('todo')).toEqual([])
      expect(second.listPlanningTags()).toEqual([])
      expect(first.listTodos({ workspaceId: 'second-workspace' })).toEqual([])
      const updated = first.updateTodo({ id: todo.id, expectedUpdatedAt: todo.updatedAt, status: 'completed' })!
      expect(updated.updatedAt).toBeGreaterThan(todo.updatedAt)
      expect(() => first.updateTodo({ id: todo.id, expectedUpdatedAt: todo.updatedAt, title: 'stale' })).toThrow()
      const event = first.createCalendarEvent({ title: 'First Core calendar', startAt: 2000, endAt: 3000, todoId: todo.id, reminders: [] })
      first.closePlanningDatabase()
      expect(first.getTodo(todo.id)).toMatchObject({ status: 'completed', tags: [{ id: tag.id }] })
      expect(first.getTodo(todo.id)?.sessionLinks.map(item => item.sessionId)).toEqual(['first-session'])
      expect(first.listCalendarEvents({ from: 2000, to: 3000 }).map(item => item.id)).toEqual([event.id])
      expect(second.getTodo(todo.id)).toBeUndefined()
      expect(second.listCalendarEvents()).toEqual([])
    } finally {
      first.closePlanningDatabase()
      second.closePlanningDatabase()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
