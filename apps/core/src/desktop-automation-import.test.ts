import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation, AutomationTriggerRecord } from '@profer/shared'
import { importDesktopAutomations } from './desktop-automation-import'
import { CoreAutomationStore } from './automation-store'
import { createCoreAgentRuntime } from './runtime'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profer-desktop-auto-import-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), desktopWorkspaceIndexPath: join(root, 'agent-workspaces.json'), desktopWorkspaceIndexWritable: true, desktopAutomationTimeZone: 'America/New_York' }
  const store = new CoreAutomationStore(join(root, 'core-automations.json'))
  const task: Automation = { id: 'legacy-task', name: 'Fixture', prompt: 'offline', active: true, scheduleType: 'interval', intervalMinutes: 60,
    channelId: 'offline', workspaceId: 'workspace', nextRunAt: 12345, createdAt: 1, updatedAt: 2,
    runHistory: [{ runAt: 1, sessionId: 'history-session', status: 'success', runId: 'history-run' }], runCount: 7 }
  return { root, config, store, task, source: join(root, 'automations.json') }
}

test('桌面Automation交接保留ID/时区/水位/历史且源文件不变，重启不复活已删任务', () => {
  const { root, config, store, task, source } = fixture()
  try {
    const raw = JSON.stringify({ version: 4, automations: [task], triggers: [] })
    writeFileSync(source, raw)
    importDesktopAutomations(config, store, 100)
    expect(store.read().automations[0]).toEqual({ ...task, timeZone: 'America/New_York' })
    expect(readFileSync(source, 'utf8')).toBe(raw)
    const next = store.read(); next.automations = []; store.write(next)
    importDesktopAutomations(config, store, 200)
    expect(store.read().automations).toEqual([])
    expect(store.read().operations).toHaveLength(1)
    writeFileSync(source, JSON.stringify({ version: 4, automations: [{ ...task, name: 'changed' }], triggers: [] }))
    expect(() => importDesktopAutomations(config, store)).toThrow('接管后变化')
    expect(store.read().automations).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('旧trigger未确认时暂停定义并标interrupted，终态和已有时区保持不变', () => {
  const { root, config, store, task, source } = fixture()
  try {
    const triggers: AutomationTriggerRecord[] = ['queued', 'blocked', 'running', 'interrupted', 'completed'].map((status, index) => ({
      triggerId: `trigger-${index}`, occurrenceId: `trigger-${index}`, automationId: task.id, status: status as AutomationTriggerRecord['status'], scheduledAt: 10, createdAt: 1, updatedAt: 2,
      ...(status === 'running' ? { runId: 'unknown-desktop-run' } : {}),
    }))
    writeFileSync(source, JSON.stringify({ version: 4, automations: [{ ...task, timeZone: 'Asia/Tokyo' }], triggers }))
    importDesktopAutomations(config, store, 99)
    expect(store.read().automations[0]).toMatchObject({ active: false, nextRunAt: 12345, timeZone: 'Asia/Tokyo', runCount: 7 })
    expect(store.read().triggers?.map(item => item.status)).toEqual(['interrupted', 'interrupted', 'interrupted', 'interrupted', 'completed'])
    expect(store.read().triggers?.[2]?.runId).toBe('unknown-desktop-run')
    expect(store.read().triggers?.[4]).toEqual(triggers[4])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('损坏/未来版本/通知/重复ID/目标冲突/非本机拒绝且源与目标保持原样', () => {
  const { root, config, store, task, source } = fixture()
  try {
    for (const value of ['{broken', JSON.stringify({ version: 99, automations: [], triggers: [] }),
      JSON.stringify({ version: 4, automations: [task, task], triggers: [] }),
      JSON.stringify({ version: 4, automations: [{ ...task, notificationTargets: [{ type: 'feishu', enabled: true }] }], triggers: [] })]) {
      writeFileSync(source, value)
      expect(() => importDesktopAutomations(config, store)).toThrow()
      expect(readFileSync(source, 'utf8')).toBe(value)
      expect(existsSync(join(root, 'core-automations.json'))).toBe(false)
    }
    writeFileSync(source, JSON.stringify({ version: 4, automations: [task], triggers: [] }))
    expect(() => importDesktopAutomations({ ...config, host: '0.0.0.0' }, store)).toThrow('本机Core')
    store.write({ version: 4, automations: [{ ...task, id: 'core-existing' }], triggers: [] })
    const before = readFileSync(join(root, 'core-automations.json'), 'utf8')
    expect(() => importDesktopAutomations(config, store)).toThrow('已有Automation')
    expect(readFileSync(join(root, 'core-automations.json'), 'utf8')).toBe(before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('项目镜像未对账或缺失中央文件时拒绝遗漏，同版本冲突不猜覆盖', () => {
  const { root, config, store, task, source } = fixture()
  try {
    const project = join(root, 'project')
    mkdirSync(join(project, '.profer'), { recursive: true })
    writeFileSync(config.desktopWorkspaceIndexPath, JSON.stringify({ version: 4, workspaces: [{ id: task.workspaceId, rootPath: project }] }))
    const mirror = join(project, '.profer', 'automations.json')
    writeFileSync(mirror, JSON.stringify({ version: 1, automations: [task], triggers: [] }))
    expect(() => importDesktopAutomations(config, store)).toThrow('项目有任务镜像')
    writeFileSync(source, JSON.stringify({ version: 4, automations: [task], triggers: [] }))
    writeFileSync(mirror, JSON.stringify({ version: 1, automations: [{ ...task, name: 'same version conflict' }], triggers: [] }))
    expect(() => importDesktopAutomations(config, store)).toThrow('未对账任务')
    expect(existsSync(join(root, 'core-automations.json'))).toBe(false)
    writeFileSync(mirror, JSON.stringify({ version: 1, automations: [task], triggers: [] }))
    importDesktopAutomations(config, store)
    expect(store.read().automations[0]?.id).toBe(task.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('隔离Core导入任务后执行/结算/重启保持ID与历史，工作区删除识别导入任务', async () => {
  const { root, config, task, source } = fixture()
  const workspace = { id: 'workspace', name: 'Fixture', slug: 'fixture', storageMode: 'managed', createdAt: 1, updatedAt: 1 }
  writeFileSync(config.desktopWorkspaceIndexPath, JSON.stringify({ version: 4, workspaces: [workspace, { ...workspace, id: 'keep', slug: 'keep', name: 'Keep' }] }))
  mkdirSync(join(config.workspaceRoot, workspace.slug), { recursive: true })
  const raw = JSON.stringify({ version: 4, automations: [{ ...task, active: false, agentRuntime: 'pi', nextRunAt: Date.now() + 60000 }], triggers: [] })
  writeFileSync(source, raw)
  const runtimeConfig = { ...config, mockAgent: true, channels: [{ id: 'offline', name: 'Offline', provider: 'anthropic' as const, apiKey: 'fixture-only' }] }
  let runtime = createCoreAgentRuntime(runtimeConfig)
  try {
    const trigger = runtime.automations.runNow(task.id)
    const deadline = Date.now() + 8000
    while (runtime.automations.manager.getAutomationTrigger(trigger.triggerId)?.status !== 'completed' && Date.now() < deadline) await Bun.sleep(10)
    expect(runtime.automations.manager.getAutomationTrigger(trigger.triggerId)?.status).toBe('completed')
    expect(runtime.automations.list()[0]).toMatchObject({ id: task.id, runCount: 8 })
    expect(runtime.automations.list()[0]?.runHistory.some(run => run.runId === 'history-run')).toBe(true)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(runtimeConfig)
    expect(runtime.automations.list()[0]).toMatchObject({ id: task.id, runCount: 8 })
    expect(runtime.automations.list()[0]?.runHistory).toHaveLength(2)
    await runtime.deleteWorkspace(workspace.id)
    expect(runtime.automations.list()).toEqual([])
    expect(readFileSync(source, 'utf8')).toBe(raw)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(runtimeConfig)
    expect(runtime.automations.list()).toEqual([])
  } finally { await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
}, 20000)

test('已知v1-v3副本共享转换保留水位和源文件，缺trigger账本暂停而不重放', () => {
  for (const version of [1, 2, 3]) {
    const { root, config, store, task, source } = fixture()
    try {
      const legacy = { ...task, scheduleType: 'weekly', sessionMode: 'new', permissionMode: 'auto', timeOfDay: '09:15', dayOfWeek: 2, dayOfMonth: 15 }
      const raw = JSON.stringify({ version, automations: [legacy] })
      writeFileSync(source, raw)
      importDesktopAutomations(config, store, 100)
      expect(store.read().automations[0]).toMatchObject({ id: task.id, active: false, nextRunAt: task.nextRunAt, runCount: task.runCount,
        sessionMode: 'daily', permissionMode: 'bypassPermissions', timeOfDay: ['09:15'], dayOfWeek: [2], dayOfMonth: [15], timeZone: config.desktopAutomationTimeZone })
      expect(store.read().automations[0]?.runHistory).toEqual(task.runHistory)
      expect(store.read().automations[0]?.dispatchBlockReason).toContain('缺少trigger账本')
      expect(store.read().operations?.[0]?.result).toMatchObject({ sourceVersion: version, missingTriggerLedger: true })
      expect(store.read().triggers).toEqual([])
      expect(readFileSync(source, 'utf8')).toBe(raw)
      importDesktopAutomations(config, store, 200)
      expect(store.read().operations).toHaveLength(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('旧版空调度字段固化为原调度器默认值，不重算nextRunAt', () => {
  const { root, config, store, task, source } = fixture()
  try {
    writeFileSync(source, JSON.stringify({ version: 1, automations: [{ ...task, scheduleType: 'monthly' }] }))
    importDesktopAutomations(config, store)
    expect(store.read().automations[0]).toMatchObject({ timeOfDay: ['09:00'], dayOfMonth: [1], nextRunAt: task.nextRunAt, active: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('旧版已有trigger账本保留终态；不接受非法旧字段或未知权限值', () => {
  const { root, config, store, task, source } = fixture()
  try {
    for (const overrides of [{ timeOfDay: '25:61' }, { dayOfWeek: 1.5 }, { dayOfMonth: 32 }, { sessionMode: 'unknown' }, { permissionMode: 'plan' }]) {
      const raw = JSON.stringify({ version: 2, automations: [{ ...task, ...overrides }], triggers: [] })
      writeFileSync(source, raw)
      expect(() => importDesktopAutomations(config, store)).toThrow()
      expect(existsSync(join(root, 'core-automations.json'))).toBe(false)
      expect(readFileSync(source, 'utf8')).toBe(raw)
    }
    const trigger: AutomationTriggerRecord = { triggerId: 'settled-old', occurrenceId: 'settled-old', automationId: task.id, scheduledAt: 1, createdAt: 1, updatedAt: 2, status: 'completed' }
    writeFileSync(source, JSON.stringify({ version: 3, automations: [task], triggers: [trigger] }))
    importDesktopAutomations(config, store)
    expect(store.read().automations[0]?.active).toBe(true)
    expect(store.read().triggers).toEqual([trigger])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('导入落盘失败不产生凭证，源文件可在修复后重试', () => {
  const { root, config, task, source, store } = fixture()
  class FailingStore extends CoreAutomationStore { override write(): void { throw new Error('fixture disk failure') } }
  try {
    const raw = JSON.stringify({ version: 4, automations: [task], triggers: [] })
    writeFileSync(source, raw)
    expect(() => importDesktopAutomations(config, new FailingStore(join(root, 'core-automations.json')))).toThrow('disk failure')
    expect(readFileSync(source, 'utf8')).toBe(raw)
    importDesktopAutomations(config, store)
    expect(store.read().automations).toHaveLength(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
