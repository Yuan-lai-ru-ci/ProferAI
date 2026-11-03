/**
 * P1-3：工作区（project）被移除后，绑定它的定时任务必须不再触发。
 *
 * 移除 project 只删索引、不动磁盘（I2），所以调度侧下一次 tick 仍能读到这条 automation；
 * 如果不在这里停用，运行时会拿不到 workspaceSlug，cwd 回落用户主目录，
 * 等于把 ~ 当项目根跑无人值守命令。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation, AutomationTriggerRecord } from '@profer/shared'

const originalConfigDir = process.env.PROFER_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'profer-automation-ws-removal-'))
process.env.PROFER_CONFIG_DIR = configDir

const manager = await import('./automation-manager')
const { getAutomationsPath } = await import('./config-paths')

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

function createBoundAutomation(name: string, workspaceId: string): Automation {
  return manager.createAutomation({
    name,
    prompt: 'work',
    scheduleType: 'interval',
    intervalMinutes: 30,
    channelId: 'channel-1',
    modelId: 'model-1',
    workspaceId,
    active: true,
  })
}

function queueTrigger(automationId: string, scheduledAt: number): void {
  const trigger: AutomationTriggerRecord = {
    triggerId: `${automationId}:${scheduledAt}`,
    occurrenceId: `${automationId}:${scheduledAt}`,
    automationId,
    scheduledAt,
    status: 'queued',
    createdAt: 1,
    updatedAt: 1,
  }
  manager.enqueueAutomationTrigger(trigger)
}

describe('pauseAutomationsForWorkspace', () => {
  test('Given 两个工作区各有任务 When 移除其中一个 Then 只停用该工作区的任务并落盘', () => {
    const removed = createBoundAutomation('removed-project-task', 'ws-removed')
    const kept = createBoundAutomation('kept-project-task', 'ws-kept')
    expect(removed.active).toBe(true)
    expect(kept.active).toBe(true)

    const paused = manager.pauseAutomationsForWorkspace('ws-removed')

    expect(paused).toEqual([removed.id])
    const afterRemoved = manager.getAutomation(removed.id)
    const afterKept = manager.getAutomation(kept.id)
    expect(afterRemoved?.active).toBe(false)
    expect(afterKept?.active).toBe(true)

    const persisted = JSON.parse(readFileSync(getAutomationsPath(), 'utf-8')) as { automations: Automation[] }
    expect(persisted.automations.find((item) => item.id === removed.id)?.active).toBe(false)
    expect(persisted.automations.find((item) => item.id === kept.id)?.active).toBe(true)
  })

  test('Given 任务还有 queued trigger When 停用 Then trigger 结算为失败，不会被下次 tick 重拉起来', () => {
    const automation = createBoundAutomation('queued-task', 'ws-queued')
    queueTrigger(automation.id, 1234)
    expect(manager.getPendingAutomationTrigger(automation.id)?.status).toBe('queued')

    manager.pauseAutomationsForWorkspace('ws-queued')

    expect(manager.getPendingAutomationTrigger(automation.id)).toBeUndefined()
    const persisted = JSON.parse(readFileSync(getAutomationsPath(), 'utf-8')) as { triggers: AutomationTriggerRecord[] }
    expect(persisted.triggers.find((item) => item.automationId === automation.id)?.status).toBe('failed')
  })

  test('Given 已经停用的任务 When 再调用一次 Then 不返回任何 id（幂等）', () => {
    const automation = createBoundAutomation('already-paused', 'ws-idempotent')
    expect(manager.pauseAutomationsForWorkspace('ws-idempotent')).toEqual([automation.id])
    expect(manager.pauseAutomationsForWorkspace('ws-idempotent')).toEqual([])
    expect(manager.pauseAutomationsForWorkspace('ws-never-existed')).toEqual([])
  })
})

/**
 * 结构性检查：ipc.ts 的 DELETE_WORKSPACE 在 project 分支必须先停用绑定任务再移除索引。
 *
 * ipc.ts 直接依赖 electron 的 ipcMain / BrowserWindow，无法在本进程内 import 验证，
 * 所以这里像 automation-ipc.test.ts 一样钉住接线点，避免「删了索引但任务还在跑」复发。
 */
describe('DELETE_WORKSPACE（project 分支）接线', () => {
  const ipcSource = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')

  test('project 分支先停用绑定任务并广播，再移除索引', () => {
    const branchStart = ipcSource.indexOf("if (deletingWorkspace.storageMode === 'project') {")
    expect(branchStart).toBeGreaterThan(-1)
    const branch = ipcSource.slice(branchStart, ipcSource.indexOf('return', branchStart))
    expect(branch).toContain('pauseAutomationsForWorkspace(id)')
    expect(branch).toContain('broadcastAutomationsChanged()')
    expect(branch.indexOf('pauseAutomationsForWorkspace(id)')).toBeLessThan(branch.indexOf('removeProjectWorkspace(id)'))
  })
})
