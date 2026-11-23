import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeCoreChannelStore } from './channel-store'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'
import type { AddressInfo } from 'node:net'
import { CoreAccountService } from './account-service'

describe('Core 独立账号', () => {
  test('拒绝非回环 HTTP', () => {
    expect(() => new CoreAccountService('/unused', 'http://example.com')).toThrow()
  })
  test('登录目录独立、密文持久化、重启恢复与登出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'core-account-'))
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v1/auth/login') return Response.json({ accessToken: 'secret-access', refreshToken: 'secret-refresh', relayToken: 'secret-relay', expiresAt: Date.now() + 3600000, userId: 'u1', email: 'test@example.com', commercialMode: true })
      if (path === '/v1/account/channels') return Response.json({ commercialMode: true, channels: [{ id: 'official', name: 'Official', provider: 'anthropic', baseUrl: '', apiKey: '', models: [{ id: 'model', name: 'Model', enabled: true }] }] })
      if (path === '/v1/auth/logout') return Response.json({ ok: true })
      return new Response('missing', { status: 404 })
    } })
    let service: CoreAccountService | undefined
    try {
      service = new CoreAccountService(root, `http://127.0.0.1:${server.port}`)
      expect(await service.operation('login', ['test@example.com', 'password'])).toMatchObject({ success: true })
      expect(service.channels[0]).toMatchObject({ apiKey: 'secret-relay', forceBearerAuth: true, baseUrl: `http://127.0.0.1:${server.port}/v1/proxy` })
      expect(readFileSync(join(root, 'account', 'channels.enc.json'), 'utf8')).not.toContain('secret-')
      const deviceId = service.deviceId
      service.dispose()
      service = new CoreAccountService(root, `http://127.0.0.1:${server.port}`)
      expect(service.deviceId).toBe(deviceId)
      await service.ready
      expect(service.channels).toHaveLength(1)
      expect(JSON.stringify(await service.operation('status'))).not.toContain('secret-')
      await service.operation('logout')
      expect(service.channels).toHaveLength(0)
      expect(await service.operation('status')).toMatchObject({ isLoggedIn: false })
      await expect(service.operation('bad')).rejects.toThrow()
    } finally { service?.dispose(); server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
})


test('过期账号恢复503后后台重试，dispose或换号后不重排旧任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-account-restore-retry-'))
  let refreshes = 0
  let release: (() => void) | undefined
  let began: (() => void) | undefined
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/v1/auth/refresh') {
      refreshes++
      if (release) { began?.(); await new Promise<void>(resolve => { release = resolve }) }
      if (refreshes === 1) return new Response('', { status: 503 })
      return Response.json({ accessToken: 'retry-access', expiresAt: Date.now() + 3600000 })
    }
    if (path === '/v1/account/channels') return Response.json({ channels: [{ id: 'official', models: [{ id: 'm', enabled: true }] }] })
    return Response.json({})
  } })
  const baseUrl = `http://127.0.0.1:${remote.port}`
  const seed = () => writeCoreChannelStore(join(root, 'account'), [{ baseUrl, session: {
    accessToken: 'expired-access', refreshToken: 'private-refresh', expiresAt: Date.now() - 1000, userId: 'u', email: 'e',
  } }] as unknown as Parameters<typeof writeCoreChannelStore>[1])
  const originalTimer = globalThis.setTimeout
  const retries: Array<() => unknown> = []
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
    if (delay === 60000) retries.push(() => handler())
    return originalTimer(handler, delay, ...args)
  }) as typeof setTimeout
  let account: CoreAccountService | undefined
  try {
    seed()
    account = new CoreAccountService(root, baseUrl)
    await account.ready
    expect(refreshes).toBe(1)
    expect(retries).toHaveLength(1)
    retries.shift()!()
    // refresh 合并已启动的后台请求，不再发起第二次续期。
    expect(await account.refresh()).toBe(true)
    expect(refreshes).toBe(2)
    expect(account.channels).toHaveLength(1)
    expect(JSON.stringify(await account.operation('status'))).not.toContain('retry-access')
    expect(readFileSync(join(root, 'account', 'channels.enc.json'), 'utf8')).not.toContain('private-refresh')
    account.dispose()

    // restore 正在等待503期间关闭；迟到响应不能重新安排定时器。
    seed(); refreshes = 0; retries.length = 0
    release = () => {}
    const started = new Promise<void>(resolve => { began = resolve })
    account = new CoreAccountService(root, baseUrl)
    await started
    account.dispose()
    release!()
    await account.ready
    expect(retries).toHaveLength(0)

    // 登出改变 generation；旧恢复不能重新安装重试任务。
    seed(); refreshes = 0
    release = () => {}
    const startedAgain = new Promise<void>(resolve => { began = resolve })
    account = new CoreAccountService(root, baseUrl)
    await startedAgain
    await account.operation('logout')
    release!()
    await account.ready
    expect(retries).toHaveLength(0)
    expect(await account.operation('status')).toEqual({ isLoggedIn: false })
  } finally {
    release?.(); account?.dispose(); globalThis.setTimeout = originalTimer
    remote.stop(true); rmSync(root, { recursive: true, force: true })
  }
})

test('真实HTTP仅本机owner能控制账号，设备授权端拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-account-http-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }, { independent: true })
  const owner = createCoreServer({ version: 'test', runtime, apiKey: 'owner' })
  const paired = createCoreServer({ version: 'test', runtime, authorizeRequest: () => true })
  await listenCoreServer(owner, '127.0.0.1', 0)
  await listenCoreServer(paired, '127.0.0.1', 0)
  const call = (server: typeof owner, operation: string, token = 'owner') => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/account/operations`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, args: [] }) })
  try {
    expect(await (await call(owner, 'status')).json()).toEqual({ result: { isLoggedIn: false } })
    expect((await call(owner, 'status', 'wrong')).status).toBe(401)
    expect((await call(paired, 'teamAuth')).status).toBe(403)
    expect((await call(owner, 'unknown')).status).toBe(400)
    expect(await (await call(owner, 'listDevices')).json()).toMatchObject({ result: { ok: false, error: '未登录团队账号' } })
  } finally { await closeCoreServer(owner); await closeCoreServer(paired); await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})

test('续期合并并隔离logout后迟到响应', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-account-race-'))
  let refreshes = 0
  let release: () => void = () => {}
  let started: () => void = () => {}
  const began = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/v1/auth/login') return Response.json({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, userId: 'u', email: 'e' })
    if (path === '/v1/account/channels') return Response.json({ channels: [] })
    if (path === '/v1/auth/refresh') { refreshes++; started(); await gate; return Response.json({ accessToken: 'late', expiresAt: Date.now() + 3600000 }) }
    return Response.json({})
  } })
  const account = new CoreAccountService(root, `http://127.0.0.1:${remote.port}`)
  try {
    await account.operation('login', ['e', 'p'])
    const one = account.refresh(); const two = account.refresh()
    expect(one).toBe(two)
    await began
    await account.operation('logout')
    release()
    expect(await one).toBe(false)
    expect(refreshes).toBe(1)
    expect(await account.operation('teamAuth')).toBeNull()
  } finally { release(); account.dispose(); remote.stop(true); rmSync(root, { recursive: true, force: true }) }
})

test('换号失败/目录失败保留旧账号；devices 401续期重试；OTP网络结构化', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-account-failure-'))
  let failLogin = false
  let failCatalog = false
  let devices = 0
  let refreshes = 0
  const access = crypto.randomUUID()
  const refreshed = crypto.randomUUID()
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/v1/auth/login' || path === '/v1/auth/register') return failLogin ? Response.json({ error: 'denied' }, { status: 401 }) : Response.json({ accessToken: access, refreshToken: crypto.randomUUID(), expiresAt: Date.now() + 3600000, userId: 'original', email: 'original@example.test' })
    if (path === '/v1/account/channels') return failCatalog ? new Response('', { status: 503 }) : Response.json({ channels: [{ id: 'official', provider: 'anthropic', models: [{ id: 'm', enabled: true }] }] })
    if (path === '/v1/auth/devices') { devices++; return request.headers.get('authorization') === `Bearer ${refreshed}` ? Response.json({ devices: [{ id: 'device' }] }) : new Response('', { status: 401 }) }
    if (path === '/v1/auth/refresh') { refreshes++; return Response.json({ accessToken: refreshed, expiresAt: Date.now() + 3600000 }) }
    return new Response('invalid-json')
  } })
  const account = new CoreAccountService(root, `http://127.0.0.1:${remote.port}`)
  try {
    expect(await account.operation('login', ['original@example.test', 'password'])).toMatchObject({ success: true })
    failLogin = true
    expect(await account.operation('login', ['other@example.test', 'wrong'])).toMatchObject({ success: false })
    expect(await account.operation('status')).toMatchObject({ teamEmail: 'original@example.test' })
    expect(account.channels).toHaveLength(1)
    failLogin = false; failCatalog = true
    expect(await account.operation('register', ['other@example.test', 'password'])).toMatchObject({ success: false })
    expect(await account.operation('teamAuth')).toMatchObject({ token: access })
    failCatalog = false
    expect(await account.operation('listDevices')).toMatchObject({ ok: true, devices: [{ id: 'device' }] })
    expect(devices).toBe(2); expect(refreshes).toBe(1)
    expect(await account.operation('sendRegistrationOtp', ['e'])).toMatchObject({ success: false, error: expect.any(String) })
  } finally { account.dispose(); remote.stop(true); rmSync(root, { recursive: true, force: true }) }
})
