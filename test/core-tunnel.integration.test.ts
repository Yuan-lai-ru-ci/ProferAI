import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createServer, connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const require = createRequire(new URL('../apps/electron/package.json', import.meta.url))
const Ws = require(join(dirname(require.resolve('ws/package.json')), 'index.js')) as typeof import('ws')
mock.module('ws', () => ({ default: Ws, WebSocket: Ws, WebSocketServer: Ws.WebSocketServer }))
const { withCoreInvitationTunnel, consumeCoreInvitation, decodeCoreInvitation, encodeCoreInvitation } = await import('../apps/electron/src/main/lib/core-invitation')
const { CoreConnectionHost } = await import('../apps/core/src/connection-host')
const { createCoreAgentRuntime } = await import('../apps/core/src/runtime')
const { CoreClient } = await import('../apps/electron/src/main/lib/core-client')

test('真实TCP隧道保留TLS身份完成邀请配对、HTTP/WS及重连，错pin不消费', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-tunnel-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  const host = await CoreConnectionHost.open(root, 'tunnel-core', { version: 'test', coreId: 'tunnel-core', apiKey: 'synthetic-owner', runtime })
  const sockets = new Set<Socket>()
  let client: InstanceType<typeof CoreClient> | undefined
  const tunnel = createServer(incoming => {
    const upstream = connect({ host: '127.0.0.1', port: host.service.state().port })
    for (const socket of [incoming, upstream]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => { incoming.destroy(); upstream.destroy() }) }
    incoming.pipe(upstream).pipe(incoming)
    incoming.on('close', () => upstream.destroy()); upstream.on('close', () => incoming.destroy())
  })
  try {
    await host.setSharing(true)
    await new Promise<void>(resolve => tunnel.listen(0, '127.0.0.1', resolve))
    const address = tunnel.address(); if (!address || typeof address === 'string') throw new Error('tunnel not listening')
    const tunnelUrl = `https://127.0.0.1:${address.port}`
    // 邀请只广告不可达地址，实际测试必须经指定TCP隧道；不允许隐式LAN回退。
    const invitation = host.service.invite(['192.0.2.1'], undefined, 300, 900)
    const original = decodeCoreInvitation(encodeCoreInvitation(invitation))
    expect(withCoreInvitationTunnel(original)).toBe(original)
    const routed = withCoreInvitationTunnel(original, ` ${tunnelUrl}/ `)
    expect(routed.endpoints).toEqual([tunnelUrl])
    expect({ ...routed, endpoints: original.endpoints }).toEqual(original)
    for (const value of ['http://127.0.0.1:17788', 'https://user:secret@host', 'https://host/path', 'https://host?token=x', 'https://host#x', 'not-url']) {
      expect(() => withCoreInvitationTunnel(original, value)).toThrow()
    }
    await expect(consumeCoreInvitation({ ...routed, pin: { algorithm: 'spki-sha256', value: `sha256/${Buffer.alloc(32).toString('base64')}` } })).rejects.toThrow('身份')
    const paired = await consumeCoreInvitation(routed)
    expect(paired.coreId).toBe(original.coreId)
    expect(paired.expiresAt).toBeGreaterThan(Date.now() + 890000)
    await expect(consumeCoreInvitation(routed)).rejects.toThrow('失效')
    const open = async () => {
      client = new CoreClient({ baseUrl: tunnelUrl, token: paired.credential, identityPin: original.pin.value, reconnect: false })
      expect((await client.identity()).coreId).toBe(original.coreId)
      await client.connect()
    }
    await open()
    const workspace = await client!.createManagedWorkspace('Tunnel workspace')
    const session = await client!.createSession({ workspaceId: workspace.id, title: 'Through tunnel', runtime: 'pi' })
    client!.close()
    await open()
    expect((await client!.getSessionDetail(session.id)).session.id).toBe(session.id)
    expect((await client!.listWorkspaces()).some(item => item.id === workspace.id)).toBe(true)
    host.service.revoke(paired.bindingId)
    await expect(client!.identity()).rejects.toThrow()
  } finally {
    client?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => tunnel.close(() => resolve()))
    await host.close(); await runtime.shutdown(); await rm(root, { recursive: true, force: true })
  }
}, 20000)
