import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { CoreConnectionHost } from './connection-host'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

function tlsCall(port: number, path: string, token?: string, payload?: unknown): Promise<{ status: number; value: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, agent: false, rejectUnauthorized: false, method: payload ? 'POST' : 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined)
  })
}

test('TLS配对与业务共用入口、owner隔离、关闭监听和重启恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-lan-'))
  const options = { version: 'test', coreId: 'test', apiKey: 'owner-key' }
  let host = await CoreConnectionHost.open(dir, 'test', options)
  const owner = createCoreServer({ ...options, connectionHandler: host.handleOwner })
  await listenCoreServer(owner, '127.0.0.1', 0)
  const address = owner.address(); if (!address || typeof address === 'string') throw new Error('listen')
  const ownerUrl = `http://127.0.0.1:${address.port}`
  try {
    expect((await fetch(`${ownerUrl}/identity`, { headers: { authorization: 'Bearer owner-key' } })).status).toBe(200)
    expect(host.service.state().sharingEnabled).toBe(false)
    const enabled = await fetch(`${ownerUrl}/connection/sharing`, { method: 'PUT', headers: { authorization: 'Bearer owner-key' }, body: JSON.stringify({ enabled: true }) })
    expect(enabled.status).toBe(200)
    for (const ttlSeconds of [300, 1800, 3600, 86400, undefined, 59, '300', null]) {
      const before = Date.now()
      const response = await fetch(`${ownerUrl}/connection/invitations`, { method: 'POST', headers: { authorization: 'Bearer owner-key' }, body: JSON.stringify({ addresses: ['127.0.0.1'], ttlSeconds }) })
      const valid = ttlSeconds === undefined || (typeof ttlSeconds === 'number' && [300, 1800, 3600, 86400].includes(ttlSeconds))
      expect(response.status).toBe(valid ? 200 : 400)
      if (valid) {
        const invitation = await response.json() as { expiresAt: number }
        expect(invitation.expiresAt).toBeGreaterThanOrEqual(before + (ttlSeconds ?? 300) * 1000)
        expect(invitation.expiresAt).toBeLessThanOrEqual(Date.now() + (ttlSeconds ?? 300) * 1000)
      }
    }
    const port = host.service.state().port
    const invite = host.service.invite(['127.0.0.1'])
    const pair = await tlsCall(port, '/connection/pair', undefined, { invitationToken: invite.invitationToken, clientName: 'Windows', bindingTtlSeconds: 2592000 })
    expect(pair.status).toBe(200)
    expect(pair.value.expiresAt as number).toBeLessThanOrEqual(Date.now() + 86400000)
    expect(pair.value.expiresAt as number).toBeGreaterThan(Date.now() + 86300000)
    const credential = pair.value.credential as string
    expect((await tlsCall(port, '/identity', credential)).value.coreId).toBe('test')
    expect((await tlsCall(port, '/identity', 'owner-key')).status).toBe(401)
    expect((await tlsCall(port, '/connection/state', credential)).status).toBe(403)
    // 普通 headless 不开放停止动作，配对 TLS 和非 owner 请求无法访问。
    for (const token of [undefined, credential, 'owner-key']) {
      expect((await tlsCall(port, '/connection/shutdown', token, {})).status).toBe(403)
    }
    for (const token of [undefined, credential]) {
      const status = await fetch(`${ownerUrl}/connection/shutdown`, {
        method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      expect(status.status).toBe(401)
    }
    expect((await fetch(`${ownerUrl}/connection/shutdown`, { method: 'POST', headers: { authorization: 'Bearer owner-key' } })).status).toBe(404)
    expect((await tlsCall(port, '/connection/pair', undefined, { invitationToken: invite.invitationToken, clientName: 'again' })).status).toBe(400)
    await host.close()
    host = await CoreConnectionHost.open(dir, 'test', options)
    expect(host.service.state().port).toBe(port)
    expect((await tlsCall(port, '/identity', credential)).status).toBe(200)
    host.service.revoke(pair.value.bindingId as string)
    expect((await tlsCall(port, '/identity', credential)).status).toBe(401)
    await host.setSharing(false)
    await expect(tlsCall(port, '/identity', credential)).rejects.toThrow()
    expect((await fetch(`${ownerUrl}/identity`, { headers: { authorization: 'Bearer owner-key' } })).status).toBe(200)
  } finally { await host.close(); await closeCoreServer(owner); rmSync(dir, { recursive: true, force: true }) }
})

test('两个真实 WSS 客户端，撤销只断开对应 binding，大响应不截断', async () => {
  const { createCoreAgentRuntime } = await import('./runtime')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const WebSocket: typeof import('ws').default = require(join(import.meta.dir, '../node_modules/ws/lib/websocket.js'))
  const dir = mkdtempSync(join(tmpdir(), 'core-wss-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: dir, workspaceRoot: join(dir, 'workspaces') })
  const host = await CoreConnectionHost.open(dir, 'wss-test', { version: 'v'.repeat(300_000), apiKey: 'owner', coreId: 'wss-test', runtime })
  const sockets: InstanceType<typeof WebSocket>[] = []
  try {
    await host.setSharing(true)
    const port = host.service.state().port
    const first = host.service.pair(host.service.invite(['127.0.0.1']).invitationToken, 'first')
    const second = host.service.pair(host.service.invite(['127.0.0.1']).invitationToken, 'second')
    for (const client of [first, second]) {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false, headers: { authorization: `Bearer ${client.credential}` } })
      sockets.push(ws)
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    }
    expect(((await tlsCall(port, '/identity', second.credential)).value.version as string).length).toBe(300_000)
    const closed = new Promise<void>(resolve => sockets[0]!.once('close', () => resolve()))
    host.service.revoke(first.bindingId)
    await closed
    expect(sockets[1]!.readyState).toBe(WebSocket.OPEN)
    const event = new Promise<string>(resolve => sockets[1]!.once('message', raw => resolve(raw.toString())))
    runtime.publish({ type: 'planning', sessionId: '', payload: { changed: true } })
    expect(await event).toContain('planning_event')
  } finally { for (const ws of sockets) ws.terminate(); await host.close(); runtime.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('配对客户端发送桌面用户消息，Core 生成自己的用户身份且不接受单轮凭据', async () => {
  const { createCoreAgentRuntime } = await import('./runtime')
  const dir = mkdtempSync(join(tmpdir(), 'core-paired-message-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: dir, workspaceRoot: join(dir, 'workspaces'), mockAgent: true })
  const host = await CoreConnectionHost.open(dir, 'test', { version: 'test', coreId: 'test', apiKey: 'owner', runtime })
  try {
    await host.setSharing(true)
    const port = host.service.state().port
    const { credential } = host.service.pair(host.service.invite(['127.0.0.1']).invitationToken, 'Windows')
    const session = runtime.sessions.create({ title: 'Remote message', runtime: 'pi', workspaceId: runtime.workspaces.createManaged('Remote').id })
    const path = `/sessions/${session.id}/messages`
    const payload = { prompt: 'Hello from paired desktop', uuid: 'desktop-message', context: { trigger: {
      schemaVersion: 1, id: 'desktop-origin', kind: 'automation', actor: { type: 'automation' }, createdAt: 1,
    } } }
    expect((await tlsCall(port, path, undefined, payload)).status).toBe(401)
    expect(await tlsCall(port, path, credential, { ...payload, credentials: {} })).toMatchObject({ status: 400, value: { error: 'authenticated_host_required' } })
    const completion = Promise.withResolvers<string | undefined>()
    let initiator: string | undefined
    runtime.subscribe(({ sessionId, payload }) => {
      if (sessionId !== session.id) return
      const event = payload as { type?: string; initiator?: string }
      if (event.type === 'runtime_started') initiator = event.initiator
      if (event.type === 'runtime_finished') completion.resolve(initiator)
    })
    const accepted = await tlsCall(port, path, credential, payload)
    expect(accepted).toMatchObject({ status: 202, value: { accepted: true } })
    expect(await completion.promise).toBe('user')
    expect(JSON.stringify(runtime.sessions.readMessages(session.id))).toContain(payload.prompt)
  } finally { await host.close(); await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }) }
}, 15_000)

test('客户端在发送邀请前校验SPKI，错pin不消费邀请', async () => {
  const { connect } = await import('node:tls')
  const { createHash, X509Certificate } = await import('node:crypto')
  const dir = mkdtempSync(join(tmpdir(), 'core-pin-'))
  const host = await CoreConnectionHost.open(dir, 'pin-test', { version: 'test', coreId: 'pin-test', apiKey: 'owner' })
  try {
    await host.setSharing(true)
    const invite = host.service.invite(['127.0.0.1'])
    const actualPin = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: host.service.state().port, rejectUnauthorized: false }, () => {
        const cert = new X509Certificate(socket.getPeerCertificate().raw)
        resolve(`sha256/${createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`)
        socket.destroy()
      }); socket.once('error', reject)
    })
    expect(actualPin).toBe(invite.pin.value)
    expect(actualPin).not.toBe(`sha256/${'A'.repeat(43)}=`)
    expect((await tlsCall(host.service.state().port, '/connection/pair', undefined, { invitationToken: invite.invitationToken, clientName: 'verified-client' })).status).toBe(200)
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('真实TLS/WS在授权截止主动断开、HTTP拒绝，owner仍可用且历史保留', async () => {
  const { createCoreAgentRuntime } = await import('./runtime')
  const { createRequire } = await import('node:module')
  const WebSocket: typeof import('ws').default = createRequire(import.meta.url)(join(import.meta.dir, '../node_modules/ws/lib/websocket.js'))
  const dir = mkdtempSync(join(tmpdir(), 'core-expiring-ws-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: dir, workspaceRoot: join(dir, 'workspaces') })
  const host = await CoreConnectionHost.open(dir, 'expiry-ws', { version: 'test', coreId: 'expiry-ws', apiKey: 'owner', runtime })
  const owner = createCoreServer({ version: 'test', coreId: 'expiry-ws', apiKey: 'owner', connectionHandler: host.handleOwner })
  await listenCoreServer(owner, '127.0.0.1', 0)
  const now = Date.now
  const originalTimeout = globalThis.setTimeout
  let expiryTick: (() => void) | undefined
  let socket: InstanceType<typeof WebSocket> | undefined
  try {
    await host.setSharing(true)
    // 捕获合法一分钟期限的计时器；手动推进时钟，不放宽生产最小时长。
    globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 60000) expiryTick = callback
      return originalTimeout(callback, delay, ...args)
    }) as typeof setTimeout
    const pairedAt = now()
    Date.now = () => pairedAt
    const invitation = host.service.invite(['127.0.0.1'], undefined, 300, 60)
    const paired = host.service.pair(invitation.invitationToken, 'expiring')
    Date.now = now
    globalThis.setTimeout = originalTimeout
    expect(expiryTick).toBeDefined()
    socket = new WebSocket(`wss://127.0.0.1:${host.service.state().port}/ws`, { rejectUnauthorized: false, headers: { authorization: `Bearer ${paired.credential}` } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    expect((await tlsCall(host.service.state().port, '/identity', paired.credential)).status).toBe(200)
    const closed = new Promise<void>(resolve => socket!.once('close', () => resolve()))
    Date.now = () => paired.expiresAt!
    expiryTick!()
    await closed
    expect((await tlsCall(host.service.state().port, '/identity', paired.credential)).status).toBe(401)
    expect(host.service.state().bindings.some(binding => binding.id === paired.bindingId)).toBe(true)
    const address = owner.address()
    if (!address || typeof address === 'string') throw new Error('owner listen')
    expect((await fetch(`http://127.0.0.1:${address.port}/connection/state`, { headers: { authorization: 'Bearer owner' } })).status).toBe(200)
  } finally {
    globalThis.setTimeout = originalTimeout; Date.now = now
    socket?.terminate(); await host.close(); await closeCoreServer(owner); runtime.dispose(); rmSync(dir, { recursive: true, force: true })
  }
})
