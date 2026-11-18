import { expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 同一临时 Core 的两个鉴权客户端，真实 HTTP 写入和 WS 事件/重放。
test('Core工作区写盘后通知全部客户端，拒绝操作不广播，离线变更可按原游标重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-workspace-events-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture-only' })
  const sockets: WebSocket[] = []
  await listenCoreServer(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const connect = async () => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer fixture-only' } })
    sockets.push(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.on('message', raw => frames.push(JSON.parse(String(raw))))
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return { socket, frames }
  }
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 4000
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    expect(check()).toBe(true)
  }
  const api = (path: string, method: string, body?: object) => fetch(`${base}${path}`, { method,
    headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    const first = await connect(), second = await connect()
    const created = await api('/workspaces', 'POST', { name: 'Created' })
    const workspace = await created.json() as { id: string }
    expect(created.status).toBe(201)
    await waitFor(() => [first, second].every(client => client.frames.some(frame => frame.kind === 'workspace_event')))
    const changes = (frames: Array<Record<string, unknown>>) => frames.filter(frame => frame.kind === 'workspace_event')
    const initial = changes(first.frames)[0]!
    const cursor = String(initial.eventId)
    expect(initial).toMatchObject({ kind: 'workspace_event', payload: { type: 'changed' }, eventId: expect.any(String) })
    expect(initial.sessionId).toBeUndefined()
    expect(changes(second.frames)[0]).toEqual(initial)
    expect(first.frames.some(frame => frame.kind === 'agent_event')).toBe(false)
    const persisted = JSON.parse(await readFile(join(root, 'workspaces.json'), 'utf8'))
    expect(persisted.workspaces[0].id).toBe(workspace.id)
    expect((await api(`/workspaces/${workspace.id}`, 'PATCH', { name: '' })).status).toBe(400)
    // HTTP之后发恢复命令作为有序屏障，确认拒绝的修改没有产生新事件。
    first.socket.send(JSON.stringify({ type: 'resume_agent_events', cursor, _cmdId: 'no-event' }))
    await waitFor(() => first.frames.some(frame => frame.kind === 'command_result' && frame.commandId === 'no-event'))
    expect(first.frames.find(frame => frame.kind === 'command_result' && frame.commandId === 'no-event')).toMatchObject({ ok: true, data: { replayed: 0 } })
    expect(changes(first.frames)).toHaveLength(1)
    second.socket.terminate()
    expect((await api(`/workspaces/${workspace.id}`, 'PATCH', { name: 'Offline rename' })).status).toBe(200)
    await waitFor(() => changes(first.frames).length === 2)
    const resumed = await connect()
    resumed.socket.send(JSON.stringify({ type: 'resume_agent_events', cursor, _cmdId: 'replay' }))
    await waitFor(() => resumed.frames.some(frame => frame.kind === 'command_result' && frame.commandId === 'replay'))
    const replayResult = resumed.frames.find(frame => frame.kind === 'command_result' && frame.commandId === 'replay')!
    expect(replayResult).toMatchObject({ ok: true, data: { requiresSnapshot: false, replayed: 1 } })
    expect(changes(resumed.frames)).toEqual([{ ...changes(first.frames)[1]!, replay: true }])
    const project = join(root, 'project'); await mkdir(project)
    const bound = await (await api('/workspaces/projects', 'POST', { rootPath: project, name: 'Project' })).json() as { workspace: { id: string } }
    await waitFor(() => changes(first.frames).length === 3)
    expect((await api(`/workspaces/${bound.workspace.id}`, 'DELETE')).status).toBe(204)
    await waitFor(() => changes(first.frames).length === 4)
    // 观察者异常不能撤销落盘的工作区修改。
    const unsubscribe = runtime.subscribe(event => { if (event.type === 'workspace') throw new Error('fixture observer failure') })
    try { expect(runtime.workspaces.update(workspace.id, { name: 'Committed' }).name).toBe('Committed') } finally { unsubscribe() }
    expect(JSON.parse(await readFile(join(root, 'workspaces.json'), 'utf8')).workspaces[0].name).toBe('Committed')
  } finally {
    for (const socket of sockets) socket.terminate()
    await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true })
  }
}, 20000)
