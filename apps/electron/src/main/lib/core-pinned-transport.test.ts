import { afterEach, describe, expect, test, mock } from 'bun:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createServer, type Server } from 'node:https'
import { X509Certificate, createHash } from 'node:crypto'
import { generate } from 'selfsigned'
import { WebSocketServer } from 'ws'
// Bun 内置 ws shim 忽略 Node https.Agent；这里测试 Electron 实际使用的 npm ws。
const require = createRequire(import.meta.url)
const NodeWebSocket = require(join(dirname(require.resolve('ws/package.json')), 'index.js')) as typeof import('ws').default
mock.module('ws', () => ({ default: NodeWebSocket }))
const { createPinnedCoreTransport } = await import('./core-pinned-transport')

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function fixture() {
  const pair = await generate([{ name: 'commonName', value: 'Core test' }], { keyType: 'ec', curve: 'P-256' })
  let requests = 0
  const server = createServer({ key: pair.private, cert: pair.cert }, (_req, res) => {
    requests++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ value: 'x'.repeat(300 * 1024) }))
  })
  servers.push(server)
  const wss = new WebSocketServer({ server })
  wss.on('connection', socket => socket.send('hello'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const pin = `sha256/${createHash('sha256').update(new X509Certificate(pair.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`
  return { baseUrl: `https://127.0.0.1:${address.port}`, pin, requests: () => requests }
}

describe('paired Core TLS transport', () => {
  test('accepts the pinned self-signed identity and reads a response larger than a relay frame', async () => {
    const core = await fixture()
    const transport = createPinnedCoreTransport(core.baseUrl, core.pin)
    try {
      const response = await transport.fetchImpl(`${core.baseUrl}/identity`, { headers: { authorization: 'Bearer test' } })
      expect(response.ok).toBe(true)
      expect((await response.json()).value.length).toBe(300 * 1024)
    } finally { transport.close() }
  })

  test('rejects the wrong identity before sending HTTP credentials', async () => {
    const core = await fixture()
    const transport = createPinnedCoreTransport(core.baseUrl, `sha256/${Buffer.alloc(32).toString('base64')}`)
    try {
      await expect(transport.fetchImpl(`${core.baseUrl}/identity`, { headers: { authorization: 'Bearer secret' } })).rejects.toThrow('身份')
      expect(core.requests()).toBe(0)
    } finally { transport.close() }
  })

  test('pins the WebSocket handshake as well', async () => {
    const core = await fixture()
    const transport = createPinnedCoreTransport(core.baseUrl, core.pin)
    const socket = transport.webSocketFactory(core.baseUrl.replace('https:', 'wss:') + '/ws', { headers: {}, protocols: [] })
    try {
      const message = await new Promise<string>((resolve, reject) => {
        socket.onmessage = event => resolve(String(event.data))
        socket.onerror = reject
      })
      expect(message).toBe('hello')
    } finally { socket.close(); transport.close() }
  })

  test('keeps authorization confined to its paired origin', async () => {
    const core = await fixture()
    const transport = createPinnedCoreTransport(core.baseUrl, core.pin)
    try {
      await expect(transport.fetchImpl('https://example.org/identity')).rejects.toThrow('地址')
    } finally { transport.close() }
  })
})
