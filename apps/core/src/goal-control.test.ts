import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGoalState } from '@profer/agent-runtime/goal-loop'
import { saveGoalStates } from '@profer/agent-runtime/goal-store'
import { ModelRuntime, createScriptedTransport, type ScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { PiAgentAdapter } from '@profer/agent-provider-pi'
import { createCoreAgentRuntime } from './runtime'

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3500
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

test('Core Goal暂停释放原owner，恢复后新Run完成；停止不继续调度', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-control-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  let transport = createScriptedTransport([{ pending: true }])
  const stream: ScriptedTransport['streamSimple'] = (model, context, options) => transport.streamSimple(model, context, options)
  prototype.stream = stream; prototype.streamSimple = stream
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const create = (title: string) => runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title, runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const first = create('pause fixture')
    const goal = await runtime.goals.start(first.id, 'pause/resume fixture', { maxConsecutiveFailures: 2, maxIterations: 5 })
    await waitFor(() => transport.calls.length === 1)
    const oldRun = runtime.goals.get(goal.id).activeRunId
    expect((await runtime.goals.pause(goal.id)).status).toBe('paused')
    await runtime.coordinator.stopAndWait(first.id)
    expect(runtime.coordinator.isRunning(first.id)).toBe(false)
    transport.releasePending()
    transport = createScriptedTransport([{ toolCall: { id: 'goal-complete', name: 'update_goal', arguments: { status: 'complete', summary: 'resumed fixture', evidence: ['resumed run observation'] } } }, { textChunks: ['DONE'] }])
    await runtime.goals.resume(goal.id)
    await waitFor(() => runtime.goals.get(goal.id).status === 'completed')
    expect(runtime.goals.get(goal.id).history?.some(item => item.status === 'complete')).toBe(true)
    expect(runtime.goals.get(goal.id).lifecycle?.some(item => item.runId === oldRun)).toBe(true)
    transport = createScriptedTransport([{ pending: true }])
    const second = create('stop fixture')
    const stopping = await runtime.goals.start(second.id, 'stop fixture', { maxConsecutiveFailures: 2 })
    await waitFor(() => transport.calls.length === 1)
    expect((await runtime.goals.stop(stopping.id)).status).toBe('stopped')
    await runtime.coordinator.stopAndWait(second.id)
    expect(runtime.coordinator.isRunning(second.id)).toBe(false)
    expect(transport.calls).toHaveLength(1)
  } finally {
    runtime.dispose(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
}, 12000)

test('Goal停止逻辑终态不提前释放未drain的provider，资源退出后可确定等待owner释放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-drain-'))
  const originalQuery = PiAgentAdapter.prototype.query
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ pending: true }])
  let release!: () => void
  let entered!: () => void
  const drain = new Promise<void>(resolve => { release = resolve })
  const draining = new Promise<void>(resolve => { entered = resolve })
  PiAgentAdapter.prototype.query = async function* (...args: Parameters<typeof originalQuery>) {
    try { yield* originalQuery.apply(this, args) }
    finally { entered(); await drain }
  }
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'drain fixture', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const goal = await runtime.goals.start(session.id, 'drain fixture')
    await waitFor(() => transport.calls.length === 1)
    const stopped = runtime.goals.stop(goal.id)
    await draining
    expect((await stopped).status).toBe('stopped')
    // 逻辑停止先交付，但未退出的provider仍持有执行权，不能提前放锁。
    expect(runtime.coordinator.isRunning(session.id)).toBe(true)
    const released = runtime.coordinator.stopAndWait(session.id)
    release()
    await released
    expect(runtime.coordinator.isRunning(session.id)).toBe(false)
    expect(transport.calls).toHaveLength(1)
  } finally {
    release(); transport.releasePending()
    await runtime.shutdown()
    PiAgentAdapter.prototype.query = originalQuery
    prototype.stream = original.stream; prototype.streamSimple = original.streamSimple
    await rm(root, { recursive: true, force: true })
  }
}, 12000)

test('Core关闭等待Goal原Run释放，磁盘保留可恢复暂停状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-shutdown-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ pending: true }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic' as const, apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] }
  const runtime = createCoreAgentRuntime(config)
  try {
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'shutdown fixture', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const goal = await runtime.goals.start(session.id, 'shutdown fixture')
    await waitFor(() => transport.calls.length === 1)
    await runtime.shutdown()
    expect(runtime.coordinator.isRunning(session.id)).toBe(false)
    const restarted = createCoreAgentRuntime(config)
    try { expect(restarted.goals.get(goal.id)).toMatchObject({ status: 'paused', reasonCode: 'app_restart', activeRunId: undefined }) }
    finally { restarted.dispose() }
  } finally {
    runtime.dispose(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test('Core Goal重启恢复暂停旧active/stopping，不盲目重放原工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-restart-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  const runtime = createCoreAgentRuntime(config)
  const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'restart fixture', runtime: 'pi' })
  runtime.dispose()
  const state = { ...createGoalState(session.id, 'restart fixture'), activeRunId: crypto.randomUUID(), iteration: 1 }
  saveGoalStates(join(root, 'core-goals.json'), [state])
  const restarted = createCoreAgentRuntime(config)
  try {
    expect(restarted.goals.get(state.id)).toMatchObject({ status: 'paused', reasonCode: 'app_restart', activeRunId: undefined })
    expect(restarted.coordinator.isRunning(session.id)).toBe(false)
    expect(restarted.sessions.readMessages(session.id)).toEqual([])
    expect(restarted.goals.get(state.id).lifecycle?.at(-1)?.runId).toBe(state.activeRunId)
  } finally { restarted.dispose(); await rm(root, { recursive: true, force: true }) }
})
