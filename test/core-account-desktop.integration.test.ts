import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime } from '../apps/core/src/runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from '../apps/core/src/server'
import { CoreClient } from '../apps/electron/src/main/lib/core-client'
import { createLocalAccountRouter } from '../apps/electron/src/main/lib/local-account-routing'

test('真实本机owner账号事件自动恢复桌面快照，不向其他Core路由或泄密', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-account-desktop-'))
  let membershipTier = 'free'
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/v1/auth/login') return Response.json({ accessToken: crypto.randomUUID(), refreshToken: crypto.randomUUID(), relayToken: crypto.randomUUID(), expiresAt: Date.now() + 3600000, userId: 'synthetic', email: 'synthetic@example.test', commercialMode: true, isAdmin: true, membershipTier })
    if (path === '/v1/auth/refresh') return Response.json({ accessToken: crypto.randomUUID(), expiresAt: Date.now() + 3600000, membershipTier })
    if (path === '/v1/account/channels') return Response.json({ commercialMode: true, channels: [{ id: 'official', name: 'Official', provider: 'openai', models: [{ id: 'synthetic-model', name: 'Synthetic', enabled: true }] }] })
    return Response.json({ ok: true })
  } })
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), accountServerUrl: upstream.url.origin }, { independent: true })
  const server = createCoreServer({ runtime, version: 'test', apiKey: 'synthetic-owner' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing owner')
  const client = new CoreClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'synthetic-owner', reconnect: false })
  const router = createLocalAccountRouter({ independent: () => true, client: () => client })
  const until = async (check: () => boolean) => {
    const end = Date.now() + 5000
    while (Date.now() < end) { try { if (check()) return } catch {} await Bun.sleep(10) }
    expect(check()).toBe(true)
  }
  try {
    await client.connect()
    expect(await router.operation('status')).toEqual({ isLoggedIn: false })
    expect(await router.operation('login', ['synthetic@example.test', 'synthetic-only'])).toMatchObject({ success: true })
    await until(() => router.snapshot().status.commercialMode === true)
    expect(router.snapshot().status.isAdmin).toBe(true)
    expect(router.snapshot().auth?.membershipTier).toBe('free')
    // 模拟另一owner客户端/后台续期，桌面不需要再点击登录。
    membershipTier = 'plus'
    expect(await runtime.accountOperation('refresh')).toBe(true)
    await until(() => router.snapshot().auth?.membershipTier === 'plus')
    expect((await client.listChannels()).map(channel => channel.id)).toEqual(['official'])
    const token = router.snapshot().auth!.token
    expect(JSON.stringify(await client.listChannels())).not.toContain(token)
    await runtime.accountOperation('logout')
    await until(() => router.snapshot().status.isLoggedIn === false)
    expect(router.snapshot().auth).toBeNull()
    client.close()
    expect(() => router.snapshot()).toThrow('未连接')
  } finally { client.close(); await closeCoreServer(server); await runtime.shutdown(); upstream.stop(true); await rm(root, { recursive: true, force: true }) }
}, 15000)
