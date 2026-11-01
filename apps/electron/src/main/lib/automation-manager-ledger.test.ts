import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation, AutomationTriggerRecord } from '@profer/shared'

const originalConfigDir = process.env.PROFER_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'profer-automation-ledger-'))
process.env.PROFER_CONFIG_DIR = configDir

const manager = await import('./automation-manager')
const { getAutomationsPath } = await import('./config-paths')

beforeAll(() => {
  manager.listAutomations()
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('automation trigger ledger persistence', () => {
  test('enqueue is persisted and repeated trigger IDs do not create duplicate occurrences', () => {
    const trigger: AutomationTriggerRecord = {
      triggerId: 'auto:123', occurrenceId: '123', automationId: 'auto', scheduledAt: 123,
      status: 'queued', createdAt: 1, updatedAt: 1,
    }
    const first = manager.enqueueAutomationTrigger(trigger)
    const repeated = manager.enqueueAutomationTrigger({ ...trigger, updatedAt: 9 })
    expect(first).toEqual(repeated)
    expect(manager.listAutomationTriggers('queued')).toHaveLength(1)
    const persisted = JSON.parse(readFileSync(getAutomationsPath(), 'utf-8')) as { triggers: AutomationTriggerRecord[] }
    expect(persisted.triggers).toHaveLength(1)
    expect(persisted.triggers[0]?.triggerId).toBe('auto:123')
  })

  test('queued automation trigger can be persisted, deduplicated, recovered and resumed', () => {
    const trigger: AutomationTriggerRecord = {
      triggerId: 'auto-1:123', occurrenceId: 'auto-1:123', automationId: 'auto-1', scheduledAt: 123,
      status: 'queued', createdAt: 1, updatedAt: 1,
    }
    manager.enqueueAutomationTrigger(trigger)
    manager.enqueueAutomationTrigger({ ...trigger, updatedAt: 10 })
    expect(manager.listAutomationTriggers('queued').filter((item) => item.automationId === 'auto-1')).toHaveLength(1)
    expect(manager.getPendingAutomationTrigger('auto-1')?.triggerId).toBe('auto-1:123')
    manager.transitionAutomationTriggerRecord('auto-1:123', 'running')
    const persistedIndex = JSON.parse(readFileSync(getAutomationsPath(), 'utf-8')) as { triggers: AutomationTriggerRecord[] }
    expect(persistedIndex.triggers.find((item) => item.triggerId === 'auto-1:123')?.status).toBe('running')
  })

  test('explicitly cancelled occurrence may be re-queued with the same stable ID, while normal repeats remain deduplicated', () => {
    const trigger: AutomationTriggerRecord = {
      triggerId: 'auto:cancelled', occurrenceId: 'cancelled', automationId: 'auto-cancelled', scheduledAt: 789,
      status: 'queued', createdAt: 1, updatedAt: 1,
    }
    manager.enqueueAutomationTrigger(trigger)
    manager.transitionAutomationTriggerRecord(trigger.triggerId, 'cancelled', { error: '调度配置已变更' })
    const resumed = manager.enqueueAutomationTrigger({ ...trigger, status: 'queued', updatedAt: 10 })
    expect(resumed).toMatchObject({ triggerId: trigger.triggerId, status: 'queued' })
    expect(manager.listAutomationTriggers().filter((item) => item.triggerId === trigger.triggerId)).toHaveLength(1)
  })

  test('real Run linkage and trigger/history terminal settlement persist atomically and count once', () => {
    const automation = manager.createAutomation({ name: 'atomic settlement', prompt: 'work', scheduleType: 'interval', intervalMinutes: 10, channelId: '', active: false })
    const trigger: AutomationTriggerRecord = {
      triggerId: `${automation.id}:10`, occurrenceId: `${automation.id}:10`, automationId: automation.id,
      scheduledAt: 10, status: 'queued', createdAt: 1, updatedAt: 1,
    }
    manager.enqueueAutomationTrigger(trigger)
    manager.linkAutomationTriggerRun(trigger.triggerId, 'shared-run', 'session-1')
    expect(() => manager.linkAutomationTriggerRun(trigger.triggerId, 'other-run')).toThrow()
    expect(() => manager.settleAutomationTrigger(trigger.triggerId, { runAt: 10, sessionId: 'session-1', status: 'success', runId: 'other-run' })).toThrow()
    expect(() => manager.settleAutomationTrigger(trigger.triggerId, { runAt: 10, sessionId: 'session-1', status: 'skipped', runId: 'shared-run' })).toThrow()
    const run = { runAt: 10, sessionId: 'session-1', status: 'success' as const, triggerId: trigger.triggerId, runId: 'shared-run' }
    expect(manager.settleAutomationTrigger(trigger.triggerId, run)?.runCount).toBe(1)
    expect(manager.settleAutomationTrigger(trigger.triggerId, run)).toBeUndefined()
    const persisted = JSON.parse(readFileSync(getAutomationsPath(), 'utf8')) as { triggers: AutomationTriggerRecord[]; automations: Automation[] }
    expect(persisted.triggers.find((item) => item.triggerId === trigger.triggerId)).toMatchObject({ status: 'completed', runId: 'shared-run', targetSessionId: 'session-1' })
    expect(persisted.automations.find((item) => item.id === automation.id)).toMatchObject({ runCount: 1, runHistory: [run] })
  })

  test('LIST projects queue and interruption records from the trigger ledger without saving a second copy', () => {
    const automation = manager.createAutomation({ name: 'visible queue', prompt: 'work', scheduleType: 'interval', intervalMinutes: 10, channelId: '', active: false })
    const statuses = ['queued', 'blocked', 'running', 'interrupted', 'completed', 'failed', 'cancelled'] as const
    for (const [position, status] of statuses.entries()) {
      manager.enqueueAutomationTrigger({
        triggerId: `${automation.id}:${position}`, occurrenceId: `occurrence:${position}`, automationId: automation.id,
        scheduledAt: position + 1, status, runId: status === 'running' ? 'real-run' : undefined,
        targetSessionId: 'target-session', boundSessionId: 'bound-session', error: `${status} reason`, createdAt: 1, updatedAt: 2,
      })
    }
    const beforeList = readFileSync(getAutomationsPath(), 'utf8')
    const projected = manager.listAutomations().find((item) => item.id === automation.id)!
    expect(projected.pendingTriggers?.map((item) => item.status)).toEqual(['queued', 'blocked', 'running', 'interrupted'])
    expect(projected.pendingTriggers?.[1]).toMatchObject({ status: 'blocked', error: 'blocked reason', targetSessionId: 'target-session' })
    expect(projected.pendingTriggers?.[2]?.runId).toBe('real-run')
    expect(projected.pendingTriggers?.[0]).not.toHaveProperty('automationId')
    expect(manager.getAutomation(automation.id)?.pendingTriggers).toEqual(projected.pendingTriggers)
    expect(readFileSync(getAutomationsPath(), 'utf8')).toBe(beforeList)
    manager.updateAutomation({ id: automation.id, name: 'renamed', pendingTriggers: [{ triggerId: 'forged' }] } as Parameters<typeof manager.updateAutomation>[0])
    const persisted = JSON.parse(readFileSync(getAutomationsPath(), 'utf8')) as { automations: Automation[] }
    expect(persisted.automations.find((item) => item.id === automation.id)).not.toHaveProperty('pendingTriggers')
    expect(manager.getAutomation(automation.id)?.pendingTriggers).toEqual(projected.pendingTriggers)
  })

  test('queue projections are isolated snapshots and disappear when their source trigger settles', () => {
    const automation = manager.createAutomation({ name: 'projection lifecycle', prompt: 'work', scheduleType: 'interval', intervalMinutes: 10, channelId: '', active: false })
    const triggerId = `${automation.id}:slot`
    manager.enqueueAutomationTrigger({ triggerId, occurrenceId: triggerId, automationId: automation.id, scheduledAt: 1,
      status: 'blocked', error: 'target busy', createdAt: 1, updatedAt: 1 })
    const projection = manager.getAutomation(automation.id)!.pendingTriggers!
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection[0])).toBe(true)
    manager.transitionAutomationTriggerRecord(triggerId, 'queued', { error: undefined })
    expect(projection[0]?.status).toBe('blocked')
    expect(manager.getAutomation(automation.id)?.pendingTriggers?.[0]?.status).toBe('queued')
    manager.settleAutomationTrigger(triggerId, { runAt: 1, sessionId: 's', status: 'success', runId: 'run' })
    expect(manager.getAutomation(automation.id)?.pendingTriggers).toEqual([])
  })

  test('queued trigger can be claimed and settled once; terminal state is persisted', () => {
    const trigger: AutomationTriggerRecord = {
      triggerId: 'auto:456', occurrenceId: '456', automationId: 'auto', scheduledAt: 456,
      status: 'queued', createdAt: 1, updatedAt: 1,
    }
    manager.enqueueAutomationTrigger(trigger)
    manager.transitionAutomationTriggerRecord('auto:456', 'running', { targetSessionId: 'session-1' })
    manager.transitionAutomationTriggerRecord('auto:456', 'completed')
    expect(manager.getAutomationTrigger('auto:456')).toMatchObject({ status: 'completed', targetSessionId: 'session-1' })
    expect(() => manager.transitionAutomationTriggerRecord('auto:456', 'running')).toThrow()
  })
})
