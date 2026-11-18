import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { createCoreAgentRuntime } from './runtime'
import type { PermissionRequest } from '@profer/shared'

test.each(['allow', 'deny', 'plan'] as const)('Core Pi Automation创建工具权限%s，身份由宿主产生', async behavior => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-auto-tool-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([
    { toolCall: { id: 'create-fixture', name: 'mcp__automation__create_automation', arguments: { name: 'offline definition', prompt: 'no external action', scheduleType: 'interval', intervalMinutes: 10, active: false } } },
    { textChunks: ['fixture done'] },
  ])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const workspace = runtime.workspaces.createManaged('fixture')
    const session = runtime.sessions.create({ title: 'tool fixture', runtime: 'pi', workspaceId: workspace.id, channelId: 'fixture', modelId: 'claude-sonnet-4-5', permissionMode: behavior === 'plan' ? 'plan' : 'auto' })
    const requests: PermissionRequest[] = []
    runtime.subscribe(event => {
      const payload = event.payload as { event?: { type?: string; request?: PermissionRequest } }
      if (payload?.event?.type === 'permission_request' && payload.event.request) {
        const request = payload.event.request; requests.push(request)
        queueMicrotask(() => runtime.respondToPermission(session.id, request.requestId, behavior === 'allow' ? 'allow' : 'deny', false, request.runId))
      }
    })
    const result = await runtime.coordinator.run(runtime.createQuery(session, 'Create a disabled automation fixture')).promise
    expect(result.status).toBe('completed')
    expect(transport.calls).toHaveLength(2)
    expect(requests).toHaveLength(behavior === 'plan' ? 0 : 1)
    if (behavior === 'allow') {
      expect(runtime.automations.list()).toHaveLength(1)
      expect(runtime.automations.list()[0]).toMatchObject({ active: false, workspaceId: workspace.id, channelId: 'fixture', agentRuntime: 'pi', sourceSessionId: session.id, promptAuthor: { type: 'agent', id: session.id } })
    } else expect(runtime.automations.list()).toEqual([])
  } finally {
    await runtime.shutdown(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple
    transport.releasePending(); await rm(root, { recursive: true, force: true })
  }
})

test('Core Pi Automation修改当前任务保留未传字段，禁止自动化递归创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-auto-update-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([
    { toolCall: { id: 'update-fixture', name: 'mcp__automation__update_automation', arguments: { name: 'renamed by fixture' } } },
    { toolCall: { id: 'recursive-fixture', name: 'mcp__automation__create_automation', arguments: { name: 'forbidden recursive', prompt: 'fixture', scheduleType: 'interval', intervalMinutes: 10, active: false } } },
    { textChunks: ['fixture done'] },
  ])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const workspace = runtime.workspaces.createManaged('fixture')
    const task = runtime.automations.create({ name: 'original', prompt: 'fixture', scheduleType: 'interval', intervalMinutes: 10, workspaceId: workspace.id, channelId: 'fixture', agentRuntime: 'pi', modelId: 'claude-sonnet-4-5', active: false })
    runtime.automations.runNow(task.id)
    const deadline = Date.now() + 5000
    while (runtime.automations.list()[0]?.runCount !== 1 && Date.now() < deadline) await Bun.sleep(10)
    expect(runtime.automations.list()).toHaveLength(1)
    expect(runtime.automations.list()[0]).toMatchObject({ name: 'renamed by fixture', prompt: 'fixture', intervalMinutes: 10, runCount: 1, active: false })
    expect(runtime.automations.list()[0]?.runHistory[0]?.status).toBe('success')
    expect(transport.calls).toHaveLength(3)
  } finally {
    await runtime.shutdown(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple
    transport.releasePending(); await rm(root, { recursive: true, force: true })
  }
})
