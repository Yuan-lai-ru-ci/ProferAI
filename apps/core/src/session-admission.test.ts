import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'

test('Given 显式工作区归属，When 创建或准备失败，Then HTTP/WS 不伪报accepted且历史仍可读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-session-admission-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'offline', name: '离线无凭据', provider: 'anthropic', apiKey: '' }] })
  const workspace = runtime.workspaces.createManaged('准入夹具')
  const session = runtime.sessions.create({ title: '历史', workspaceId: workspace.id, runtime: 'claude', channelId: 'offline', modelId: 'fixture' })
  const server = createCoreServer({ version: 'test', runtime, apiKey: 'fixture' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as { port: number }).port
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer fixture' } })
  let sequence = 0
  const command = (input: object) => new Promise<Record<string, unknown>>(resolve => {
    const id = `admission:${++sequence}`
    const listener = (raw: WebSocket.RawData) => { const frame = JSON.parse(raw.toString()); if (frame.commandId === id) { socket.off('message', listener); resolve(frame) } }
    socket.on('message', listener)
    socket.send(JSON.stringify({ ...input, _cmdId: id }))
  })
  const post = async (path: string, body: object) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    for (const workspaceId of [undefined, 'missing']) {
      expect(() => runtime.sessions.create({ title: '拒绝', workspaceId })).toThrow()
      expect(() => runtime.ensureWorkspaceSession({ workspaceId: workspaceId! })).toThrow()
      expect((await post('/sessions', { workspaceId })).status).toBeGreaterThanOrEqual(400)
      expect((await command({ type: 'create_session', workspaceId })).ok).toBe(false)
    }
    expect(runtime.sessions.list()).toHaveLength(1)
    expect(runtime.ensureWorkspaceSession({ workspaceId: workspace.id, channelId: 'different', modelId: 'different' })).toMatchObject({ id: session.id, agentRuntime: 'claude', channelId: 'offline', modelId: 'fixture' })
    // 缺凭据在provider启动前失败，不调用任何模型。
    expect((await post(`/sessions/${session.id}/messages`, { prompt: '离线' })).status).toBeGreaterThanOrEqual(400)
    expect((await command({ type: 'send_message', sessionId: session.id, prompt: '离线' })).ok).toBe(false)
    const token = Symbol('占用夹具')
    runtime.coordinator.ownership.claim({ sessionId: session.id, runtime: 'claude', token })
    expect((await post(`/sessions/${session.id}/messages`, { prompt: '占用' })).status).toBe(409)
    expect((await command({ type: 'send_message', sessionId: session.id, prompt: '占用' })).ok).toBe(false)
    runtime.coordinator.ownership.release(session.id, token)
    runtime.sessions.updateMeta(session.id, { workspaceId: 'missing' })
    expect((await post(`/sessions/${session.id}/messages`, { prompt: '无效归属' })).status).toBeGreaterThanOrEqual(400)
    expect((await command({ type: 'send_message', sessionId: session.id, prompt: '无效归属' })).ok).toBe(false)
    runtime.sessions.updateMeta(session.id, { workspaceId: undefined })
    expect(runtime.sessions.list().some(item => item.id === session.id)).toBe(true)
    expect(runtime.sessions.readMessages(session.id)).toBeArray()
  } finally { socket.terminate(); await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 15000)
