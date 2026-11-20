import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'
import WebSocket from 'ws'
import type { AgentSessionUiAction } from '@profer/shared'

/** 真实WS传输夹具，不跨Core边界导入Electron客户端。 */
class SessionClient {
  private socket: WebSocket
  private sequence = 0
  private lastFrame = ''
  private pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
  constructor(port: number, onEvent: (payload: unknown) => void) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer fixture-only' } })
    this.socket.on('message', raw => {
      this.lastFrame = raw.toString()
      const frame = JSON.parse(this.lastFrame)
      if (frame.kind === 'agent_event') onEvent(frame.payload)
      const waiting = this.pending.get(frame.commandId)
      if (!waiting) return
      this.pending.delete(frame.commandId)
      if (frame.ok) waiting.resolve(frame.data)
      else waiting.reject(new Error(frame.error))
    })
  }
  connect(): Promise<void> {
    return new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject) })
  }
  command(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(++this.sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`会话命令超时：${id}; last=${this.lastFrame}`)) }, 3000)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.socket.send(JSON.stringify({ ...command, _cmdId: id }))
    })
  }
  applySessionUiAction(sessionId: string, action: AgentSessionUiAction, expectedRevision?: number): Promise<Record<string, unknown>> {
    return this.command({ type: 'session_ui_action', sessionId, action, expectedRevision })
  }
  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise(resolve => { this.socket.once('close', () => resolve()); this.socket.terminate() })
  }
}

test('Core WebSocket幂等接管旧删除快照，不重算并拒绝同sourceRequestId异参', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-legacy-delete-wire-'))
  await writeFile(join(root, 'desktop-workspaces.json'), JSON.stringify({ version: 4, workspaces: [{ id: 'legacy-workspace', name: '历史工作区', slug: 'legacy', createdAt: 0, updatedAt: 0 }] }))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true, desktopWorkspaceIndexPath: join(root, 'desktop-workspaces.json') })
  const server = createCoreServer({ version: 'test', runtime, apiKey: 'fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const client = new SessionClient((server.address() as { port: number }).port, () => {})
  try {
    const parent = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'legacy parent', runtime: 'pi' })
    const child = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'old snapshot child', runtime: 'pi' })
    runtime.sessions.updateMeta(child.id, { parentSessionId: parent.id, sourceDelegationId: 'relation' })
    const snapshot = { sourceRequestId: 'legacy-request', sessionId: parent.id, sessionIds: [parent.id], workspaceId: parent.workspaceId }
    await client.connect()
    const accepted = await client.command({ type: 'import_legacy_deletion', ...snapshot })
    expect(accepted).toMatchObject({ sessionIds: [parent.id] })
    expect(runtime.deletions.snapshot()[0]?.sessions.map(meta => meta.id)).toEqual([parent.id])
    expect(await client.command({ type: 'import_legacy_deletion', ...snapshot })).toEqual(accepted)
    const conflict = await client.command({ type: 'import_legacy_deletion', ...snapshot, sessionIds: [child.id, parent.id] }).then(() => 'accepted', error => String(error))
    expect(conflict).toContain('参数冲突')
    const malformed = await client.command({ type: 'import_legacy_deletion', sourceRequestId: 'invalid-elements', sessionId: child.id, sessionIds: [child.id, 42] }).then(() => 'accepted', error => String(error))
    expect(malformed).toContain('快照无效')
    expect(runtime.deletions.snapshot()).toHaveLength(1)
    await runtime.deletions.drain()
    expect(runtime.sessions.getMeta(child.id)?.id).toBe(child.id)
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
  } finally { await client.close(); await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('Core拥有显示状态：鉴权命令、原子toggle、revision冲突、重启保留和安全投影', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-session-ui-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  await writeFile(join(root, 'settings.json'), JSON.stringify({ manualReadConfirmEnabled: true }))
  let runtime = createCoreAgentRuntime(config)
  const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'fixture', runtime: 'pi' })
  const server = createCoreServer({ version: 'test', runtime, apiKey: 'fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as { port: number }).port
  const frames: unknown[] = []
  const client = new SessionClient(port, payload => frames.push(payload))
  try {
    await client.connect()
    const detail = await fetch(`http://127.0.0.1:${port}/sessions/${session.id}/detail`, { headers: { authorization: 'Bearer fixture-only' } })
    expect(await detail.json()).toMatchObject({ session: { id: session.id, title: 'fixture' }, active: false })
    expect((await fetch(`http://127.0.0.1:${port}/sessions/${session.id}/detail`)).status).toBe(401)
    const owner = runtime.coordinator.ownership.claim({ sessionId: session.id, runtime: 'pi' })
    if (!owner.ok) throw new Error('fixture claim failed')
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/sessions/${session.id}/detail`, { headers: { authorization: 'Bearer fixture-only' } })).json()).toMatchObject({ active: true })
    } finally { runtime.coordinator.ownership.release(session.id, owner.owner.token) }
    const idle = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'idle stop fixture', runtime: 'pi' })
    expect(await client.command({ type: 'stop_agent', sessionId: idle.id })).toEqual({ sessionId: idle.id, stopped: false })
    const missingStop = await client.command({ type: 'stop_agent', sessionId: 'missing' }).then(() => 'unexpected success', error => String(error))
    expect(missingStop).toContain('session not found')
    const pinned = await client.applySessionUiAction(session.id, { type: 'toggle_pin' })
    expect(pinned).toMatchObject({ pinned: true, updatedAt: session.updatedAt, revision: 1 })
    await Promise.all([client.applySessionUiAction(session.id, { type: 'toggle_pin' }), client.applySessionUiAction(session.id, { type: 'toggle_pin' })])
    expect(runtime.sessions.getMeta(session.id)?.pinned).toBe(true)
    const conflict = await client.applySessionUiAction(session.id, { type: 'toggle_pin' }, 0).then(() => 'unexpected success', error => String(error))
    expect(conflict).toContain('REVISION_CONFLICT')
    await client.applySessionUiAction(session.id, { type: 'set_unread', unread: true })
    const beforeAutomaticRead = runtime.sessions.getMeta(session.id)?.revision
    await client.applySessionUiAction(session.id, { type: 'set_unread', unread: false, explicit: false })
    expect(runtime.sessions.getMeta(session.id)).toMatchObject({ completedButUnconfirmed: true, revision: beforeAutomaticRead })
    await client.applySessionUiAction(session.id, { type: 'set_unread', unread: false, explicit: true })
    expect(runtime.sessions.getMeta(session.id)?.completedButUnconfirmed).toBe(false)
    await client.applySessionUiAction(session.id, { type: 'set_unread', unread: true })
    const archived = await client.applySessionUiAction(session.id, { type: 'toggle_archive' })
    expect(archived).toMatchObject({ archived: true, pinned: false, completedButUnconfirmed: false })
    await client.applySessionUiAction(session.id, { type: 'set_unread', unread: true })
    expect(runtime.sessions.getMeta(session.id)).toMatchObject({ archived: true, completedButUnconfirmed: true })
    const state = { reason: 'error' as const, label: 'fixture failure', at: 100 }
    await client.applySessionUiAction(session.id, { type: 'set_interruption', state })
    await client.applySessionUiAction(session.id, { type: 'set_interruption', state: null })
    expect(runtime.sessions.getMeta(session.id)?.lastInterruptReason).toBeUndefined()
    const child = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'child', runtime: 'pi' })
    runtime.sessions.updateMeta(child.id, { parentSessionId: session.id, sdkSessionId: 'private-native-id', piSessionFile: 'private-path' })
    const childDetail = await (await fetch(`http://127.0.0.1:${port}/sessions/${child.id}/detail`, { headers: { authorization: 'Bearer fixture-only' } })).json()
    expect(JSON.stringify(childDetail)).not.toContain('private-native-id')
    expect(JSON.stringify(childDetail)).not.toContain('private-path')
    const before = runtime.sessions.getMeta(child.id)?.revision
    await client.applySessionUiAction(child.id, { type: 'toggle_pin' })
    expect(runtime.sessions.getMeta(child.id)?.revision).toBe(before)
    const invalid = await client.applySessionUiAction(session.id, { type: 'set_unread', unread: 'bad' } as never).then(() => 'unexpected success', error => String(error))
    expect(invalid).toContain('无效')
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'session_projection', session: expect.objectContaining({ id: session.id, archived: true }) }))
    expect(JSON.stringify(frames)).not.toContain('private-native-id')
    expect(JSON.stringify(frames)).not.toContain('private-path')
    const deleted = await client.command({ type: 'delete_session', sessionId: child.id })
    expect(deleted).toMatchObject({ requestId: expect.any(String), sessionIds: [child.id] })
    await runtime.deletions.drain()
    const snapshot = await client.command({ type: 'core_snapshot' })
    expect((await fetch(`http://127.0.0.1:${port}/sessions/${child.id}/detail`, { headers: { authorization: 'Bearer fixture-only' } })).status).toBe(404)
    expect(snapshot.tombstones).toContainEqual({ sessionId: child.id, revision: expect.any(Number) })
    expect(snapshot.deletionStatuses).toContainEqual(expect.objectContaining({ kind: 'session_deletion', sessionId: child.id, status: 'completed' }))
    expect((snapshot.sessions as Array<{ id: string }>).some(item => item.id === child.id)).toBe(false)
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'session_projection', operation: 'delete', sessionId: child.id }))
    await client.close()
    await closeCoreServer(server)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.sessions.getMeta(session.id)).toMatchObject({ archived: true, completedButUnconfirmed: true })
  } finally {
    await client.close()
    if (server.listening) await closeCoreServer(server)
    await runtime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

test('Core运行开始/结束维护草稿和未读，不依赖桌面连接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-unread-lifecycle-'))
  await writeFile(join(root, 'settings.json'), JSON.stringify({ manualReadConfirmEnabled: true }))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'fixture', runtime: 'pi' })
    runtime.sessions.updateMeta(session.id, { draft: true, completedButUnconfirmed: true })
    const events: string[] = []
    runtime.subscribe(event => {
      const payload = event.payload as { type?: string; kind?: string; session?: { completedButUnconfirmed?: boolean; draft?: boolean } }
      if (payload.type === 'runtime_started') {
        expect(runtime.sessions.getMeta(session.id)).toMatchObject({ draft: false, completedButUnconfirmed: false })
        events.push('started')
      }
      if (payload.type === 'runtime_finished') {
        expect(runtime.sessions.getMeta(session.id)?.completedButUnconfirmed).toBe(true)
        events.push('finished')
      }
    })
    const query = runtime.createQuery(session, 'offline fixture')
    const handle = runtime.coordinator.run({ ...query, initiator: 'user' }, { onEvent() {}, onComplete() {}, onError() {} })
    expect((await handle.promise).status).toBe('completed')
    expect(events).toEqual(['started', 'finished'])
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 15000)
