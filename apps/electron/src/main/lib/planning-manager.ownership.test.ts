import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'profer-planning-owner-'))
const original = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = root
let attached = true
let target = 'local'
mock.module('./core-local-bridge', () => ({ getLocalCoreClient: () => attached ? {} : null }))
mock.module('./core-target-service', () => ({ getCurrentCoreTargetId: () => target }))
mock.module('./config-paths', () => ({ getPlanningDatabasePath: () => join(root, 'planning.db') }))
const manager = await import('./planning-manager')
afterAll(() => {
  manager.closePlanningDatabase()
  if (original === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = original
  rmSync(root, { recursive: true, force: true })
})
test('Core attached 时 Agent/直接存储入口拒绝，提醒轮询不再领取业务提醒', () => {
  expect(() => manager.listTodos()).toThrow('CORE_PLANNING_OWNED')
  expect(() => manager.createTodo({ title: 'must not persist' })).toThrow('CORE_PLANNING_OWNED')
  expect(manager.claimDuePlanningReminders()).toEqual([])
})
test('远端断连仍不得访问本机 Planning', () => {
  attached = false; target = 'remote'
  expect(() => manager.listTodos()).toThrow('CORE_PLANNING_OWNED')
  target = 'local'
})
