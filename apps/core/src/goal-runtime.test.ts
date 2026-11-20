import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelRuntime, createScriptedTransport, type ScriptedTurn } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { createCoreAgentRuntime, type CoreAgentRuntime } from './runtime'

async function waitFor(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}
const report = (status: 'continue' | 'complete' | 'blocked'): ScriptedTurn => ({ toolCall: { id: crypto.randomUUID(), name: 'update_goal', arguments: { status, summary: `fixture ${status}`, evidence: ['offline fixture observation'] } } })

// 真实Core+GoalController+Coordinator+Pi SDK；只有模型transport为离线脚本。
test.each(['complete', 'blocked'] as const)('Core Goal结构化continue后自主多轮到%s并持久化', async target => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([report('continue'), { textChunks: ['first done'] }, report(target), { textChunks: ['second done'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic' as const, apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] }
  let runtime: CoreAgentRuntime | undefined
  try {
    runtime = createCoreAgentRuntime(config)
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'goal fixture', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const state = await runtime.goals.start(session.id, 'Goal fixture', { maxConsecutiveFailures: 2, maxIterations: 3 })
    await waitFor(() => runtime!.goals.get(state.id).status === (target === 'complete' ? 'completed' : 'blocked'))
    const current = runtime.goals.get(state.id)
    expect(current.iteration).toBe(2)
    expect(current.history?.map(item => item.status)).toEqual(['continue', target])
    expect(transport.calls).toHaveLength(4)
    const ledger = JSON.parse(await readFile(join(root, 'core-agent-runs.json'), 'utf8'))
    expect(ledger.runs).toHaveLength(2)
    expect(ledger.runs.every((run: { status: string }) => run.status === 'completed')).toBe(true)
    expect(ledger.triggers.every((trigger: { actor: { type: string } }) => trigger.actor.type === 'system')).toBe(true)
    expect(ledger.runs.every((run: { taskId: string }) => run.taskId === state.id)).toBe(true)
    runtime.dispose()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.goals.get(state.id).status).toBe(target === 'complete' ? 'completed' : 'blocked')
    const visible = runtime.sessions.readMessages(session.id).filter(message => (message as { _goalVisibleResult?: boolean })._goalVisibleResult)
    expect(visible).toHaveLength(1)
    if (target === 'blocked') {
      const blockedId = runtime.goals.get(state.id).blockedTodoId
      expect(blockedId).toBeTruthy()
      expect(runtime.planning.getTodo(blockedId!)?.status).toBe('open')
      expect(runtime.planning.listTodos()).toHaveLength(1)
      runtime.dispose()
      runtime = createCoreAgentRuntime(config)
      expect(runtime.planning.listTodos()).toHaveLength(1)
      expect(runtime.sessions.readMessages(session.id).filter(message => (message as { _goalVisibleResult?: boolean })._goalVisibleResult)).toHaveLength(1)
    }
  } finally {
    runtime?.dispose(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test.each(['invalid-report', 'provider-error'] as const)('Core Goal %s 不能当作完成', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-invalid-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport(kind === 'invalid-report'
    ? [{ toolCall: { id: 'invalid-complete', name: 'update_goal', arguments: { status: 'complete', summary: 'not enough evidence', evidence: [] } } }, { textChunks: ['全部完成'] }]
    : [report('complete'), { errorMessage: 'fixture provider rejected' }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'invalid report', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const state = await runtime.goals.start(session.id, 'invalid report fixture', { maxConsecutiveFailures: 1, maxIterations: 1 })
    await waitFor(() => !['active', 'stopping'].includes(runtime.goals.get(state.id).status))
    const final = runtime.goals.get(state.id)
    expect(final.status).not.toBe('completed')
    expect(final.lastEvidence ?? []).not.toContain('全部完成')
    if (kind === 'provider-error') expect(final.reasonCode).toBe('run_error')
    expect(transport.calls).toHaveLength(2)
  } finally {
    runtime.dispose(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['tokens', 'duration'] as const)('Core Goal %s预算按实际用量在本轮结束后限制续跑', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-resource-budget-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([report('continue'), { textChunks: ['continue fixture'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'resource budget', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const state = await runtime.goals.start(session.id, 'resource budget', { maxConsecutiveFailures: 3, ...(kind === 'tokens' ? { maxTokens: 1 } : { maxDurationMs: 1 }) })
    await waitFor(() => runtime.goals.get(state.id).status === 'budget_limited')
    const final = runtime.goals.get(state.id)
    expect(final.iteration).toBe(1)
    if (kind === 'tokens') expect(final.usage?.totalTokens).toBeGreaterThan(0)
    else expect(final.elapsedMs).toBeGreaterThan(0)
    expect(transport.calls).toHaveLength(2)
  } finally {
    runtime.dispose(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
})

test('Core Goal正文声称完成不结束Goal，预算在轮次边界生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-goal-budget-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ textChunks: ['全部已完成，请结束Goal'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'budget fixture', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'fixture', modelId: 'claude-sonnet-4-5' })
    const state = await runtime.goals.start(session.id, 'budget fixture', { maxConsecutiveFailures: 3, maxIterations: 1 })
    await waitFor(() => runtime.goals.get(state.id).status === 'budget_limited')
    expect(runtime.goals.get(state.id).iteration).toBe(1)
    expect(transport.calls).toHaveLength(1)
    await expect(runtime.goals.resume(state.id)).rejects.toThrow('预算不足')
  } finally {
    runtime.dispose(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
})
