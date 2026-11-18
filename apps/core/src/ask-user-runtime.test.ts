import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 真实Pi SDK和Core/WS，仅替换模型传输；每例独立配置、账本、工作区、临时端口。
test.each(['auto', 'plan', 'bypassPermissions'] as const)('Core Pi %s 问答恢复并通过原Run返回答案', async permissionMode => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-ask-user-'))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const originalStream = prototype.stream
  const originalSimple = prototype.streamSimple
  const transport = createScriptedTransport([
    { toolCall: { id: 'ask-fixture', name: 'AskUserQuestion', arguments: { questions: [{ question: 'Choose fixture', options: [{ label: 'A' }, { label: 'B' }] }] } } },
    { textChunks: ['ANSWER_RECEIVED'] },
  ])
  prototype.stream = transport.streamSimple
  prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
    channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }],
  })
  const server = createCoreServer({ version: 'ask-fixture', runtime, apiKey: 'ask-test-only' })
  let socket: WebSocket | undefined
  const session = runtime.sessions.create({ title: 'ask fixture', runtime: 'pi', channelId: 'fixture', modelId: 'claude-sonnet-4-5', permissionMode })
  try {
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const handle = runtime.coordinator.run(runtime.createQuery(session, 'Ask the fixture question'))
    const deadline = Date.now() + 2500
    while (!runtime.askUser.getPendingRequests().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    const request = runtime.askUser.getPendingRequests()[0]
    if (!request) throw new Error(`AskUser未进入pending；outcome=${JSON.stringify(await handle.promise)}；modelCalls=${transport.calls.length}`)
    expect(request).toBeDefined()
    expect(request!.runId).toBeString()
    const ledgerPath = join(root, 'core-agent-runs.json')
    expect(JSON.parse(await readFile(ledgerPath, 'utf8')).runs).toContainEqual(expect.objectContaining({ id: request!.runId, status: 'waiting' }))
    // Core已有等待请求，客户端后来连接/重载仍可恢复，而不是重新发起一轮。
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer ask-test-only' } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    let nextId = 0
    const command = (body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> => new Promise((resolve, reject) => {
      const id = `ask:${++nextId}`
      const receive = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString())
        if (frame.commandId !== id) return
        clearTimeout(timer)
        socket!.off('message', receive)
        resolve(frame)
      }
      const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('ask fixture timed out')) }, 2000)
      socket!.on('message', receive)
      socket!.send(JSON.stringify({ ...body, _cmdId: id }))
    })
    expect(await command({ type: 'list_pending_requests', sessionId: session.id })).toMatchObject({ ok: true, data: { askUsers: [expect.objectContaining({ requestId: request!.requestId, sessionId: session.id, runId: request!.runId })] } })
    const response = { type: 'respond_ask_user', sessionId: session.id, requestId: request!.requestId, runId: request!.runId, answers: { 'Choose fixture': 'B' } }
    expect(await command({ ...response, runId: 'wrong-run' })).toMatchObject({ ok: true, data: false })
    expect(await command(response)).toMatchObject({ ok: true, data: true })
    expect(await command(response)).toMatchObject({ ok: true, data: false })
    expect(await handle.promise).toEqual({ status: 'completed' })
    expect(runtime.askUser.getPendingRequests()).toEqual([])
    expect(JSON.stringify(runtime.sessions.readMessages(session.id))).toContain('Choose fixture')
    expect(JSON.stringify(runtime.sessions.readMessages(session.id))).toContain('B')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    expect(ledger.runs).toHaveLength(1)
    expect(ledger.events.map((event: { type: string }) => event.type)).toContain('resumed')
    expect(transport.calls).toHaveLength(2)
  } finally {
    socket?.terminate()
    await closeCoreServer(server)
    if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
    runtime.dispose()
    prototype.stream = originalStream
    prototype.streamSimple = originalSimple
    transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
})
