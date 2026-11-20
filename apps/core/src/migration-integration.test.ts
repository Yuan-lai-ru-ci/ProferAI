import { expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DelegationContext } from '@profer/agent-runtime/delegation-tool-operations'
import { createCoreAgentRuntime } from './runtime'
import { CoreEventWindow } from './event-window'

// 整体回归用隔离Core，不接用户渠道，也不访问真实模型。
test('Core委派完整生命周期：隔离会话、结果、消费、重启恢复及父级停止归属', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delegation-integration-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic' as const, apiKey: 'unused', enabled: true,
      agentRuntimes: ['pi' as const], models: [{ id: 'fixture-model', name: 'fixture', enabled: true }] }] }
  let runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('delegation integration')
    const parent = runtime.sessions.create({ title: 'parent', runtime: 'pi', channelId: 'fixture', modelId: 'fixture-model', workspaceId: workspace.id, permissionMode: 'bypassPermissions' })
    // 不在fixture结束后自动启动父模型轮次；实际唤醒规则仍由服务测试覆盖。
    runtime.sessions.updateMeta(parent.id, { stoppedByUser: true })
    const ctx: DelegationContext = { sessionId: parent.id, workspaceId: workspace.id, channelId: 'fixture', modelId: 'fixture-model', agentRuntime: 'pi', permissionMode: 'bypassPermissions' }
    const request = { operationId: 'fixture-create-once', task: 'Return synthetic fixture result', placement: 'current' as const,
      presetReference: { presetId: 'standard', presetScope: 'builtin-meta' as const } }
    const created = await runtime.delegations.delegate(ctx, request)
    const repeated = await runtime.delegations.delegate(ctx, request)
    expect(repeated).toEqual(created)
    expect(runtime.delegations.snapshot()).toHaveLength(1)
    const view = created.delegation as { delegationId: string; childSessionId: string; projection: { executionSessionId: string } }
    expect(view.childSessionId).not.toBe(parent.id)
    expect(view.projection.executionSessionId).toBe(view.childSessionId)
    expect(runtime.sessions.getMeta(view.childSessionId)).toMatchObject({ sourceDelegationId: view.delegationId, parentSessionId: parent.id, sourceSessionId: parent.id, delegationPlacement: 'current', delegationRelation: 'subtask' })
    const waited = await runtime.delegations.wait(ctx, { delegationIds: [view.delegationId], timeoutSeconds: 10 })
    expect(waited.status).toBe('completed')
    expect(runtime.delegations.snapshot()[0]).toMatchObject({ status: 'completed', resultConsumedAt: expect.any(Number) })
    expect(runtime.listRuns().find(run => run.taskId === view.delegationId)?.status).toBe('completed')
    const continuation = { operationId: 'fixture-continue-once', delegationId: view.delegationId, message: 'Synthetic follow up' }
    const follow = await runtime.delegations.continue(ctx, continuation)
    expect(await runtime.delegations.continue(ctx, continuation)).toEqual(follow)
    expect(runtime.listRuns().filter(run => run.taskId === view.delegationId)).toHaveLength(2)
    expect((follow.delegation as { childSessionId: string }).childSessionId).toBe(view.childSessionId)
    await runtime.delegations.stop(ctx, view.delegationId)
    expect(runtime.delegations.snapshot()[0]?.status).toBe('cancelled')
    const sub = await runtime.delegations.delegate(ctx, { task: 'subtask', presetReference: request.presetReference })
    const independent = await runtime.delegations.delegate(ctx, { task: 'independent', placement: 'independent', relation: 'independent', presetReference: request.presetReference })
    const subId = (sub.delegation as { delegationId: string }).delegationId
    const independentId = (independent.delegation as { delegationId: string }).delegationId
    await runtime.stopDelegationsForParent(parent.id)
    expect(runtime.delegations.snapshot().find(record => record.delegationId === subId)?.status).toBe('cancelled')
    expect(runtime.delegations.snapshot().find(record => record.delegationId === independentId)?.cancelRequested).toBeUndefined()
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.delegations.snapshot().every(record => record.status !== 'running')).toBe(true)
    expect(runtime.coordinator.isRunning(parent.id)).toBe(false)
    expect(runtime.delegations.getResults(ctx, [view.delegationId])).toHaveProperty('delegations')
    expect(await runtime.delegations.delegate(ctx, request)).toEqual(created)
    expect(runtime.delegations.snapshot()).toHaveLength(3)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 25000)

test('Core项目会话读写按既有布局，项目路径失效不回落中央目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-owned-layout-'))
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const workspace = runtime.workspaces.bindProject({ rootPath: projectRoot }).workspace
    const session = runtime.sessions.create({ title: 'project fixture', runtime: 'pi', workspaceId: workspace.id })
    expect(session.storageLayout).toBe('project')
    const message = { type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'isolated fixture' } } as unknown as import('@profer/shared').SDKMessage
    runtime.sessions.appendMessages(session.id, [message])
    expect(await readFile(join(projectRoot, '.profer', 'sessions', session.id, 'messages.jsonl'), 'utf8')).toContain('isolated fixture')
    expect(runtime.sessions.readMessages(session.id)).toHaveLength(1)
    await rm(projectRoot, { recursive: true })
    expect(() => runtime.sessions.readMessages(session.id)).toThrow('根目录不可用')
    expect(() => runtime.sessions.appendMessages(session.id, [message])).toThrow('根目录不可用')
    expect(await readFile(join(root, 'agent-sessions', `${session.id}.jsonl`), 'utf8').then(() => true, () => false)).toBe(false)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core事件恢复窗口：精确补发、有限保留及跨进程epoch必须快照', () => {
  const window = new CoreEventWindow(2)
  const cursor = window.cursor
  const first = window.append({ kind: 'agent_event', sessionId: 'fixture', payload: 'first' })
  const second = window.append({ kind: 'agent_event', sessionId: 'fixture', payload: 'second' })
  expect(window.resume(cursor).events).toEqual([first, second])
  window.append({ kind: 'automation_event', payload: 'third' })
  expect(window.resume(cursor).requiresSnapshot).toBe(true)
  expect(window.resume(first.eventId).events).toHaveLength(2)
  expect(window.resume(new CoreEventWindow().cursor).requiresSnapshot).toBe(true)
})
