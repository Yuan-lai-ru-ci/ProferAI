import { expect, test } from 'bun:test'
import { createAutomationManager, migrateLegacyAutomationFields, type AutomationsIndex } from './automation-manager'

test('共享历史字段迁移只改副本字段、不重算ID/时区/nextRunAt/历史且幂等', () => {
  const source = { version: 1, automations: [{ id: 'old', name: 'old', prompt: 'old', active: false, scheduleType: 'weekly', intervalMinutes: 0,
    channelId: 'channel', workspaceId: 'workspace', nextRunAt: 123, createdAt: 1, updatedAt: 2, runHistory: [{ runAt: 1, sessionId: 'session', status: 'success' }],
    sessionMode: 'new', permissionMode: 'auto', timeOfDay: '09:15', dayOfWeek: 2, dayOfMonth: 14, timeZone: 'Asia/Tokyo' }] }
  const before = JSON.stringify(source)
  // fixture刻意表示历史schema，而非当前Automation写入输入。
  const copy = JSON.parse(before) as AutomationsIndex
  expect(migrateLegacyAutomationFields(copy)).toBe(true)
  expect(copy.version).toBe(4)
  expect(copy.automations[0]).toMatchObject({ id: 'old', nextRunAt: 123, updatedAt: 2, timeZone: 'Asia/Tokyo', sessionMode: 'daily', permissionMode: 'bypassPermissions', timeOfDay: ['09:15'], dayOfWeek: [2], dayOfMonth: [14] })
  expect(JSON.stringify(copy.automations[0]?.runHistory)).toBe(JSON.stringify(source.automations[0]!.runHistory))
  expect(migrateLegacyAutomationFields(copy)).toBe(false)
  expect(JSON.stringify(source)).toBe(before)
})

test('交接暂停原因在LIST保持可见，显式重新启用清除原因', () => {
  let index: AutomationsIndex = { version: 4, automations: [{ id: 'old', name: 'old', prompt: 'old', active: false, scheduleType: 'interval', intervalMinutes: 60,
    channelId: 'channel', workspaceId: 'workspace', nextRunAt: 123, createdAt: 1, updatedAt: 2, runHistory: [], dispatchBlockReason: '旧版本缺少trigger账本' }], triggers: [] }
  const manager = createAutomationManager({ readIndex: () => structuredClone(index), writeIndex: next => { index = next }, now: () => 1000,
    presetReferenceForAutomation: () => ({ presetId: 'code', presetScope: 'builtin-meta' }), assertValidBoundAutomation() {} })
  expect(manager.listAutomations()[0]?.dispatchBlockReason).toContain('缺少trigger账本')
  manager.updateAutomation({ id: 'old', active: true })
  expect(manager.listAutomations()[0]?.dispatchBlockReason).toBeUndefined()
})
