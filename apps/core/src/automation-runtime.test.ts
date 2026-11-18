import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime, type CoreAgentRuntime } from './runtime'
import { createAutomationTriggerId } from '@profer/agent-runtime/automation-dispatch'
import { computeNextRunAt, automationDayKey } from '@profer/agent-runtime/automation-schedule'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'

async function waitFor(check: () => boolean) {
  const until = Date.now() + 5000
  while (!check() && Date.now() < until) await Bun.sleep(10)
  expect(check()).toBe(true)
}
async function fixture(run: (runtime: CoreAgentRuntime, root: string) => Promise<void>, mockAgent = true) {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-automation-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent,
    channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com', models: [{ id: 'claude-sonnet-4-5', name: 'fixture', enabled: true }] }] })
  try { await run(runtime, root) } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}
function definition(runtime: CoreAgentRuntime) {
  const workspace = runtime.workspaces.createManaged('automation fixture')
  return { name: 'offline automation', prompt: 'return fixture text only', scheduleType: 'interval' as const, intervalMinutes: 10, agentRuntime: 'pi' as const, channelId: 'fixture', modelId: 'claude-sonnet-4-5', workspaceId: workspace.id }
}

test('Core Automation到期执行、重复tick去重、真实Run原子结算与自动停用', async () => fixture(async (runtime, root) => {
  const task = runtime.automations.create({ ...definition(runtime), maxRuns: 1 })
  runtime.automations.manager.setNextRunAt(task.id, Date.now() - 1000)
  for (let i = 0; i < 4; i++) runtime.automations.tick()
  await waitFor(() => runtime.automations.list()[0]?.runCount === 1)
  const result = runtime.automations.list()[0]!
  expect(result.active).toBe(false)
  expect(result.completedAt).toBeNumber()
  expect(result.runHistory[0]?.status).toBe('success')
  expect(result.runHistory[0]?.runId).toBeTruthy()
  expect(runtime.automations.manager.listAutomationTriggers()).toHaveLength(1)
  const ledger = JSON.parse(await readFile(join(root, 'core-agent-runs.json'), 'utf8'))
  expect(ledger.runs).toHaveLength(1)
  expect(ledger.triggers[0].actor).toEqual({ type: 'automation', id: task.id })
  expect(ledger.triggers[0].authorization.kind).toBe('scheduled')
  expect(ledger.runs[0].taskId).toBe(`automation:${task.id}`)
  expect(ledger.runs[0].status).toBe('completed')
  const saved = JSON.parse(await readFile(join(root, 'core-automations.json'), 'utf8'))
  expect(saved.automations[0].runCount).toBe(1)
  expect(saved.triggers[0].status).toBe('completed')
}))

test('Core Automation手动运行暂停定义但不重新启用、绑定会话忙时排队', async () => fixture(async runtime => {
  const input = definition(runtime)
  const session = runtime.sessions.create({ title: 'bound', runtime: 'pi', workspaceId: input.workspaceId, channelId: input.channelId, modelId: input.modelId, permissionMode: 'bypassPermissions' })
  const task = runtime.automations.create({ ...input, boundSessionId: session.id, active: false })
  const token = Symbol('fixture busy')
  expect(runtime.coordinator.ownership.claim({ sessionId: session.id, runtime: 'pi', token }).ok).toBe(true)
  const trigger = runtime.automations.runNow(task.id)
  expect(trigger.status).toBe('queued')
  expect(runtime.automations.list()[0]?.runCount).toBe(0)
  runtime.coordinator.ownership.release(session.id, token)
  runtime.automations.tick()
  await waitFor(() => runtime.automations.list()[0]?.runCount === 1)
  expect(runtime.automations.list()[0]?.active).toBe(false)
  expect(runtime.automations.list()[0]?.runHistory[0]?.sessionId).toBe(session.id)
}))

test('Core Automation绑定会话auto模式明确blocked而不静默提权或回落', async () => fixture(async runtime => {
  const input = definition(runtime)
  const session = runtime.sessions.create({ title: 'bound', runtime: 'pi', workspaceId: input.workspaceId, channelId: input.channelId, modelId: input.modelId, permissionMode: 'auto' })
  const task = runtime.automations.create({ ...input, boundSessionId: session.id })
  const trigger = runtime.automations.runNow(task.id)
  expect(trigger.status).toBe('blocked')
  expect(trigger.error).toContain('未授权无人值守')
  expect(runtime.sessions.getMeta(session.id)?.permissionMode).toBe('auto')
  expect(runtime.automations.list()[0]?.runCount).toBe(0)
}))

test('Core Automation重启：已完成Run补结算一次；派发窗口无Run不重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-automation-restart-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true, channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic' as const, apiKey: 'unused' }] }
  let runtime = createCoreAgentRuntime(config)
  try {
    const task = runtime.automations.create(definition(runtime))
    runtime.automations.runNow(task.id)
    await waitFor(() => runtime.automations.list()[0]?.runCount === 1)
    await runtime.shutdown()
    const path = join(root, 'core-automations.json')
    const index = JSON.parse(await readFile(path, 'utf8'))
    index.automations[0].runCount = 0; index.automations[0].runHistory = []
    index.triggers[0].status = 'running'
    await writeFile(path, JSON.stringify(index))
    runtime = createCoreAgentRuntime(config)
    expect(runtime.automations.list()[0]?.runCount).toBe(1)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.automations.list()[0]?.runCount).toBe(1)
    const at = Date.now() - 1000, id = createAutomationTriggerId(task.id, at)
    runtime.automations.manager.setNextRunAt(task.id, at)
    runtime.automations.manager.enqueueAutomationTrigger({ triggerId: id, occurrenceId: id, automationId: task.id, scheduledAt: at, status: 'queued', createdAt: at, updatedAt: at })
    runtime.automations.manager.transitionAutomationTriggerRecord(id, 'running', { runId: crypto.randomUUID() })
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.automations.manager.getAutomationTrigger(id)?.status).toBe('interrupted')
    runtime.automations.tick()
    expect(runtime.automations.list()[0]?.runCount).toBe(1)
    expect(runtime.automations.manager.listAutomationTriggers()).toHaveLength(2)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core Automation真实Pi SDK离线transport执行且共享Run落终态', async () => {
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ textChunks: ['offline automation done'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  try {
    await fixture(async runtime => {
      const task = runtime.automations.create(definition(runtime))
      runtime.automations.runNow(task.id)
      await waitFor(() => runtime.automations.list()[0]?.runCount === 1)
      const history = runtime.automations.list()[0]?.runHistory[0]
      expect(history?.error ?? 'success').toBe('success')
      expect(transport.calls).toHaveLength(1)
    }, false)
  } finally { prototype.stream = original.stream; prototype.streamSimple = original.streamSimple }
})

test('任务时区在异地Core保持墙上时间、DST缺失/重复时刻和月底规则', () => {
  expect(computeNextRunAt({ scheduleType: 'daily', timeOfDay: ['09:00'], timeZone: 'Asia/Shanghai' }, Date.parse('2026-11-12T00:00:00Z'))).toBe(Date.parse('2026-11-12T01:00:00Z'))
  expect(computeNextRunAt({ scheduleType: 'daily', timeOfDay: ['02:30'], timeZone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'))).toBe(Date.parse('2026-03-09T06:30:00Z'))
  expect(computeNextRunAt({ scheduleType: 'daily', timeOfDay: ['01:30'], timeZone: 'America/New_York' }, Date.parse('2026-11-01T05:45:00Z'))).toBe(Date.parse('2026-11-01T06:30:00Z'))
  expect(computeNextRunAt({ scheduleType: 'monthly', dayOfMonth: [31], timeOfDay: ['09:00'], timeZone: 'Asia/Shanghai' }, Date.parse('2026-02-01T00:00:00Z'))).toBe(Date.parse('2026-02-28T01:00:00Z'))
  expect(automationDayKey(Date.parse('2026-11-12T01:00:00Z'), 'America/New_York')).toBe('2026-11-11')
})
