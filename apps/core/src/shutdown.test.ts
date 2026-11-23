import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, Agent, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import type { CoreConnectionInvitation } from '@profer/shared'
import { request as requestTls } from 'node:https'
import { readLocalCoreOwner } from '@profer/session-store/execution-lock'
import { MOCK_AGENT_NOTICE } from './mock-agent'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

// 超时只使测试失败，绝不充当生产进程的退出策略。
async function bounded<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('关机未在限定时间内完成')), milliseconds)
    })])
  } finally { clearTimeout(timer!) }
}

function spawnMockCore(root: string, port: number | undefined, ...args: string[]) {
  return Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts'), ...(port === undefined ? [] : ['--listen', `127.0.0.1:${port}`]), '--config-dir', root, '--mock-agent', ...args], {
    env: { ...process.env, PROFER_CORE_LISTEN: undefined, PROFER_CORE_API_KEY: 'shutdown-fixture', PROFER_CORE_WORKSPACE_ROOT: join(root, 'workspaces'), PROFER_CORE_CHANNELS_JSON: '[]' },
    stdout: 'pipe', stderr: 'pipe',
  })
}

async function waitForMockCore(child: ReturnType<typeof spawnMockCore>, base: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text())
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) return } catch {}
    await Bun.sleep(30)
  }
  throw new Error('mock Core 未就绪')
}

test('Given Core已监听 When 重复关闭 Then 共享同一关闭等待且可重复调用', async () => {
  const server = createCoreServer({ version: 'shutdown-fixture' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const first = closeCoreServer(server)
  expect(closeCoreServer(server)).toBe(first)
  await bounded(first)
  await closeCoreServer(server)
  expect(server.listening).toBe(false)
})

test('Given 临时mock Core有WebSocket和HTTP长连接 When SIGTERM Then 正常退出且重启不自动重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-shutdown-'))
  const children: ReturnType<typeof Bun.spawn>[] = []
  const sockets: WebSocket[] = []
  const agent = new Agent({ keepAlive: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: 'Bearer shutdown-fixture' }
  const launch = async () => {
    const child = spawnMockCore(root, port)
    children.push(child)
    await waitForMockCore(child, base)
    return child
  }
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=shutdown-fixture`)
    sockets.push(ws)
    const frames: unknown[] = []
    ws.on('message', data => frames.push(JSON.parse(String(data))))
    await bounded(new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) }))
    return { ws, frames }
  }
  try {
    const child = await launch()
    const identity = await (await fetch(`${base}/identity`, { headers })).json()
    await connect()
    await new Promise<void>((resolve, reject) => {
      const req = request(`${base}/health`, { agent }, response => { response.resume(); response.once('end', resolve) })
      req.once('error', reject); req.end()
    })
    const post = async (path: string, body: object) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(result))
      return result
    }
    const workspace = await post('/workspaces', { name: 'shutdown-fixture' }) as { id: string }
    const session = await post('/workspace-sessions', { workspaceId: workspace.id }) as { id: string }
    await post(`/sessions/${session.id}/messages`, { prompt: '退出持久化哨兵' })
    const messagesBefore = await (await fetch(`${base}/sessions/${session.id}/messages`, { headers })).json()
    expect(JSON.stringify(messagesBefore)).toContain('退出持久化哨兵')
    child.kill('SIGTERM')
    // mock 正在运行中；必须等待停止与落盘，而不是直接退出。
    expect(await bounded(child.exited)).toBe(0)
    const restarted = await launch()
    expect(await (await fetch(`${base}/identity`, { headers })).json()).toEqual(identity)
    const messagesAfter = await (await fetch(`${base}/sessions/${session.id}/messages`, { headers })).json()
    expect(JSON.stringify(messagesAfter)).toContain('退出持久化哨兵')
    expect(await (await fetch(`${base}/sessions/${session.id}/detail`, { headers })).json()).toMatchObject({ active: false })
    const connected = await connect()
    await Bun.sleep(100)
    expect(connected.frames).toHaveLength(1)
    expect(connected.frames[0]).toMatchObject({ kind: 'hello' })
    restarted.kill('SIGTERM')
    expect(await bounded(restarted.exited)).toBe(0)
  } finally {
    agent.destroy()
    for (const ws of sockets) ws.terminate()
    for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

for (const transport of ['HTTP', 'WebSocket'] as const) {
  test(`Given ${transport}消息停在prepareUserTurn When 关闭并dispose后释放 Then 不得创建迟到运行`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'core-shutdown-gate-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
    const workspace = runtime.workspaces.createManaged('gate')
    const session = runtime.ensureWorkspaceSession({ workspaceId: workspace.id })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    runtime.goals.prepareUserTurn = async () => { entered(); await gate }
    let runs = 0
    const run = runtime.coordinator.run.bind(runtime.coordinator)
    runtime.coordinator.run = (...args) => { runs++; return run(...args) }
    const server = createCoreServer({ version: 'gate', runtime, apiKey: 'gate' })
    let ws: WebSocket | undefined
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const before = runtime.sessions.readMessages(session.id)
    try {
      let http: Promise<unknown> | undefined
      if (transport === 'HTTP') {
        http = fetch(`http://127.0.0.1:${port}/sessions/${session.id}/messages`, { method: 'POST', headers: { authorization: 'Bearer gate', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '不得迟到运行' }) }).catch(() => undefined)
      } else {
        ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=gate`)
        await bounded(new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject) }))
        ws.send(JSON.stringify({ type: 'send_message', sessionId: session.id, prompt: '不得迟到运行' }))
      }
      await bounded(preparing)
      await closeCoreServer(server)
      const shutdown = runtime.shutdown()
      expect(runtime.shutdown()).toBe(shutdown)
      await shutdown
      release()
      await http
      await Bun.sleep(30)
      expect(runs).toBe(0)
      expect(runtime.listRuns()).toHaveLength(0)
      expect(runtime.sessions.readMessages(session.id)).toEqual(before)
      expect(() => runtime.createQuery(session, '不得准入')).toThrow('Core 正在关闭')
      expect(() => runtime.queueMessage(session.id, '不得排队')).toThrow('Core 正在关闭')
    } finally {
      release()
      ws?.terminate()
      await closeCoreServer(server)
      await runtime.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test.skipIf(!['darwin', 'linux'].includes(process.platform))('owner 断连不影响独立 Core：配对客户端继续运行、同根拒绝第二进程、owner 可重连', async () => {
  const port = await freePort()
  const root = await mkdtemp(join(tmpdir(), 'core-owner-disconnect-'))
  const baseUrl = `http://127.0.0.1:${port}`
  const token = 'shutdown-fixture'
  let child = spawnMockCore(root, port, '--desktop-independent')
  let contender: ReturnType<typeof spawnMockCore> | undefined
  let owner: WebSocket | undefined
  let reopened: WebSocket | undefined
  const ownerRequest = async (path: string, method = 'GET', body?: object) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200)
    return response.json()
  }
  const ownerSocket = () => new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
  const open = (ws: WebSocket) => bounded(new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) }))
  try {
    await waitForMockCore(child, baseUrl)
    const endpoint = readLocalCoreOwner(root)
    expect(endpoint).toMatchObject({ pid: child.pid, port, token })
    owner = ownerSocket()
    await open(owner)
    const identity = await ownerRequest('/identity')
    await ownerRequest('/connection/sharing', 'PUT', { enabled: true })
    const invitation = await ownerRequest('/connection/invitations', 'POST', { addresses: ['127.0.0.1'] }) as CoreConnectionInvitation
    let credential: string | undefined
    const pairedRequest = <T>(path: string, method = 'GET', body?: object) => bounded(new Promise<T>((resolve, reject) => {
      const req = requestTls(`${invitation.endpoints[0]}${path}`, {
        // 与 connection-host 测试一致：仅对测试进程的回环自签 listener。
        method, agent: false, rejectUnauthorized: false, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      }, response => {
        let data = ''
        response.setEncoding('utf8').on('data', chunk => { data += chunk })
        response.once('error', reject)
        response.once('end', () => {
          if (!response.statusCode || response.statusCode >= 300) return reject(new Error(`${path}: ${response.statusCode} ${data}`))
          try { resolve(JSON.parse(data) as T) } catch (error) { reject(error) }
        })
      })
      req.once('error', reject)
      req.setTimeout(4000, () => req.destroy(new Error(`${path}: TLS 请求超时`)))
      req.end(body && JSON.stringify(body))
    }))
    const binding = await pairedRequest<{ credential: string; bindingId: string }>('/connection/pair', 'POST', { invitationToken: invitation.invitationToken, clientName: 'fixture' })
    credential = binding.credential
    await bounded(new Promise<void>(resolve => { owner!.once('close', resolve); owner!.close() }))

    contender = spawnMockCore(root, await freePort())
    expect(await bounded(contender.exited)).toBe(1)
    expect(await new Response(contender.stderr).text()).toContain('同一配置根已有 Core 执行进程')

    const workspace = await pairedRequest<{ id: string }>('/workspaces', 'POST', { name: 'owner-disconnected' })
    const session = await pairedRequest<{ id: string }>('/workspace-sessions', 'POST', { workspaceId: workspace.id, runtime: 'pi', title: '断连后新任务' })
    const path = `/sessions/${session.id}/messages`
    const prompt = 'owner 已关闭，配对客户端发起任务'
    expect(await pairedRequest(path, 'POST', { prompt })).toMatchObject({ accepted: true })
    const deadline = Date.now() + 6000
    let messages = ''
    do {
      messages = JSON.stringify(await pairedRequest(path))
      if (messages.includes(MOCK_AGENT_NOTICE)) break
      await Bun.sleep(30)
    } while (Date.now() < deadline)
    expect(messages).toContain(prompt)
    expect(messages).toContain(MOCK_AGENT_NOTICE)
    expect(child.exitCode).toBeNull()
    reopened = ownerSocket()
    await open(reopened)
    expect(await ownerRequest('/identity')).toEqual(identity)
    expect((await ownerRequest('/connection/state')).bindings).toContainEqual(expect.objectContaining({ id: binding.bindingId }))
    expect(JSON.stringify(await ownerRequest(path))).toContain(MOCK_AGENT_NOTICE)
    for (const token of [undefined, credential]) {
      const denied = await fetch(`${baseUrl}/connection/shutdown`, {
        method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000),
      })
      expect(denied.status).toBe(401)
    }
    await expect(pairedRequest('/connection/shutdown', 'POST', {})).rejects.toThrow('403')
    expect(child.exitCode).toBeNull()
    const accepted = await fetch(`${baseUrl}/connection/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ accepted: true })
    expect(await bounded(child.exited)).toBe(0)
    expect(() => readLocalCoreOwner(root)).toThrow()
    child = spawnMockCore(root, undefined, '--desktop-independent')
    const restarted = await bounded((async () => {
      for (;;) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text())
        try { return readLocalCoreOwner(root) } catch { await Bun.sleep(30) }
      }
    })())
    expect(restarted).toMatchObject({ pid: child.pid, coreId: endpoint.coreId })
    expect(restarted.port).toBeGreaterThan(0)
    const restartedIdentity = await fetch(`http://127.0.0.1:${restarted.port}/identity`, {
      headers: { authorization: `Bearer ${restarted.token}` }, signal: AbortSignal.timeout(3000),
    })
    expect(await restartedIdentity.json()).toEqual(identity)
    expect(await pairedRequest('/identity')).toEqual(identity)
    expect(JSON.stringify(await pairedRequest(path))).toContain(MOCK_AGENT_NOTICE)
  } finally {
    owner?.terminate()
    reopened?.terminate()
    for (const process of [child, contender]) {
      if (!process) continue
      if (process.exitCode === null) process.kill('SIGKILL')
      await process.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
