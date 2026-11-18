import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 真Core/Coordinator/Pi SDK，脚本模型，临时数据库/工作区/端口；不调用真实模型。
test.each(['approve_auto', 'approve_edit', 'deny', 'feedback'] as const)('Core Pi计划审批%s 决定后续真实文件工具执行', async action => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-plan-approval-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const originalStream = prototype.stream
  const originalSimple = prototype.streamSimple
  const transport = createScriptedTransport([
    { toolCall: { id: 'exit-plan', name: 'ExitPlanMode', arguments: { plan: 'Write one harmless fixture' } } },
    { toolCall: { id: 'write-after-plan', name: 'write', arguments: { path: 'approved.txt', content: 'plan approval fixture' } } },
    { textChunks: ['DONE'] },
  ])
  prototype.stream = transport.streamSimple
  prototype.streamSimple = transport.streamSimple
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
    channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic' as const, apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }],
  }
  const runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'plan-approval-test', runtime, apiKey: 'fixture-only' })
  const session = runtime.sessions.create({ title: 'plan fixture', runtime: 'pi', channelId: 'fixture', modelId: 'claude-sonnet-4-5', permissionMode: 'plan' })
  let socket: WebSocket | undefined
  const unsubscribe = runtime.subscribe(event => {
    const payload = event.payload as { event?: { type?: string; request?: import('@profer/shared').PermissionRequest } }
    if (payload.event?.type === 'permission_request' && payload.event.request) {
      const request = payload.event.request
      queueMicrotask(() => runtime.respondToPermission(request.sessionId, request.requestId, 'allow', false, request.runId))
    }
  })
  try {
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const handle = runtime.coordinator.run(runtime.createQuery(session, 'Submit and await plan approval'))
    const deadline = Date.now() + 2500
    while (!runtime.exitPlan.getPendingRequests().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    const request = runtime.exitPlan.getPendingRequests()[0]
    if (!request) throw new Error(`No plan request: ${JSON.stringify(await handle.promise)}`)
    expect(runtime.sessions.getMeta(session.id)?.permissionMode).toBe('plan')
    expect(JSON.parse(await readFile(join(root, 'core-agent-runs.json'), 'utf8')).runs).toContainEqual(expect.objectContaining({ id: request.runId, status: 'waiting' }))
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer fixture-only' } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    let next = 0
    const command = (body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> => new Promise((resolve, reject) => {
      const id = `plan:${++next}`
      const receive = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString())
        if (frame.commandId !== id) return
        clearTimeout(timer); socket!.off('message', receive); resolve(frame)
      }
      const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('fixture command timeout')) }, 2000)
      socket!.on('message', receive)
      socket!.send(JSON.stringify({ ...body, _cmdId: id }))
    })
    expect(await command({ type: 'list_pending_requests', sessionId: session.id })).toMatchObject({ ok: true, data: { exitPlans: [expect.objectContaining({ requestId: request.requestId, runId: request.runId })] } })
    const response = { type: 'respond_exit_plan_mode', requestId: request.requestId, sessionId: session.id, runId: request.runId, action, feedback: 'revise fixture' }
    expect(await command({ ...response, runId: 'wrong' })).toMatchObject({ ok: true, data: false })
    expect(await command(response)).toMatchObject({ ok: true, data: true })
    expect(await command(response)).toMatchObject({ ok: true, data: false })
    expect(await handle.promise).toEqual({ status: 'completed' })
    const expectedMode = action === 'approve_auto' ? 'bypassPermissions' : action === 'approve_edit' ? 'auto' : 'plan'
    expect(runtime.sessions.getMeta(session.id)?.permissionMode).toBe(expectedMode)
    const target = join(runtime.createQuery(session, '').cwd!, 'approved.txt')
    if (expectedMode === 'plan') expect(await Bun.file(target).exists()).toBe(false)
    else expect(await readFile(target, 'utf8')).toBe('plan approval fixture')
    expect(runtime.exitPlan.getPendingRequests()).toEqual([])
    expect(transport.calls).toHaveLength(3)
  } finally {
    unsubscribe(); socket?.terminate(); await closeCoreServer(server)
    if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
    runtime.dispose(); prototype.stream = originalStream; prototype.streamSimple = originalSimple
    transport.releasePending(); await rm(root, { recursive: true, force: true })
  }
})
