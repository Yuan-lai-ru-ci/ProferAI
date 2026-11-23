import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { isCoreConnectionTtl } from '@profer/shared'
import { CoreDiscoveryPublisher } from './connection-discovery'
import { CoreConnectionService } from './connection-service'
import { attachCoreWebSocketGateway } from './gateway'
import { createCoreServer, listenCoreServer, type CoreServerOptions } from './server'

function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { size += chunk.length; if (size > 16_384) throw new Error('连接请求过大'); chunks.push(Buffer.from(chunk)) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('连接请求无效')
  return value as Record<string, unknown>
}
const bearer = (request: IncomingMessage): string | undefined => request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined
const loopback = (request: IncomingMessage): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')

/** 一个业务处理器，两种传输；LAN 不接收 owner 凭据，也不开放管理路径。 */
export class CoreConnectionHost {
  private discovery?: CoreDiscoveryPublisher
  private tlsServer?: HttpsServer
  private sockets = new Map<Duplex, Set<string>>()
  private transition = Promise.resolve()
  private constructor(readonly service: CoreConnectionService, private options: CoreServerOptions, private onShutdown?: () => void) {}
  static async open(configDir: string, coreId: string, options: CoreServerOptions, onShutdown?: () => void): Promise<CoreConnectionHost> {
    const host = new CoreConnectionHost(await CoreConnectionService.open(configDir, coreId), options, onShutdown)
    host.service.onRevoke(id => { for (const [socket, ids] of host.sockets) if (ids.has(id)) socket.destroy() })
    if (host.service.state().sharingEnabled) await host.setSharing(true)
    return host
  }
  readonly handleOwner = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (!path.startsWith('/connection/')) return false
    if (!loopback(request) || !this.options.apiKey || bearer(request) !== this.options.apiKey) { json(response, 401, { error: 'unauthorized' }); return true }
    try {
      if (path === '/connection/shutdown' && request.method === 'POST' && this.onShutdown) {
        this.options.runtime?.beginShutdown()
        // 如果客户端提前断开，仍完成已接受的关机，避免 Core 留在停止接单状态。
        const finishShutdown = () => {
          response.off('finish', finishShutdown)
          response.off('close', finishShutdown)
          this.onShutdown?.()
        }
        response.once('finish', finishShutdown)
        response.once('close', finishShutdown)
        response.setHeader('connection', 'close')
        json(response, 202, { accepted: true })
      } else if (path === '/connection/state' && request.method === 'GET') json(response, 200, this.service.state())
      else if (path === '/connection/sharing' && request.method === 'PUT') {
        const input = await body(request); if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
        await this.setSharing(input.enabled); json(response, 200, this.service.state())
      } else if (path === '/connection/invitations' && request.method === 'POST') {
        if (!this.tlsServer?.listening) throw new Error('请先开启共享')
        const input = await body(request)
        if (input.addresses !== undefined && (!Array.isArray(input.addresses) || input.addresses.length > 32 || !input.addresses.every(value => typeof value === 'string'))) throw new Error('addresses 无效')
        if (input.ttlSeconds !== undefined && !isCoreConnectionTtl(input.ttlSeconds)) throw new Error('邀请时长无效')
        if (input.bindingTtlSeconds !== undefined && !isCoreConnectionTtl(input.bindingTtlSeconds)) throw new Error('连接期限无效')
        json(response, 200, this.service.invite(input.addresses as string[] | undefined, typeof input.name === 'string' ? input.name : undefined, input.ttlSeconds as number | undefined, input.bindingTtlSeconds as number | undefined))
      } else if (path.startsWith('/connection/bindings/') && request.method === 'DELETE') json(response, 200, { revoked: this.service.revoke(path.slice('/connection/bindings/'.length)) })
      else json(response, 404, { error: 'not_found' })
    } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
    return true
  }
  setSharing(enabled: boolean): Promise<void> {
    const next = this.transition.then(() => this.changeSharing(enabled))
    this.transition = next.catch(() => {})
    return next
  }
  private async changeSharing(enabled: boolean): Promise<void> {
    if (!enabled) { await this.stopTransport(); this.service.setSharing(false); return }
    if (this.tlsServer?.listening) return
    if (!this.options.apiKey) throw new Error('共享需要本机 owner API Key')
    const authenticate = (token: string | undefined): string | undefined => token === this.options.apiKey ? undefined : this.service.authenticate(token)
    // 从同一个工厂取得真实业务路由，禁止给临时 HTTP server 注册额外 gateway。
    const business = createCoreServer({ ...this.options, apiKey: undefined, connectionHandler: undefined, authorizeRequest: request => Boolean(authenticate(bearer(request))) })
    const server = createHttpsServer(this.service.tls, async (request, response) => {
      const path = new URL(request.url ?? '/', 'https://localhost').pathname
      if (path.startsWith('/connection/')) {
        if (path !== '/connection/pair' || request.method !== 'POST') { json(response, 403, { error: 'owner_only' }); return }
        try { const input = await body(request); if (typeof input.invitationToken !== 'string' || typeof input.clientName !== 'string') throw new Error('配对请求无效'); json(response, 200, this.service.pair(input.invitationToken, input.clientName)) }
        catch { json(response, 400, { error: 'invalid_invitation' }) }
        return
      }
      const id = authenticate(bearer(request))
      if (!id) { json(response, 401, { error: 'unauthorized' }); return }
      this.track(request.socket, id)
      business.emit('request', request, response)
    })
    server.headersTimeout = 15_000; server.requestTimeout = 30_000
    if (this.options.runtime) {
      const gateway = attachCoreWebSocketGateway({ server: server as Server, runtime: this.options.runtime, token: '', authenticate: token => Boolean(authenticate(token)) })
      server.once('close', () => gateway.close())
    }
    server.prependListener('upgrade', request => {
      const url = new URL(request.url ?? '/', 'https://localhost')
      const protocol = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()).find(value => value.startsWith('profer.'))?.slice(7)
      const id = authenticate(bearer(request) ?? url.searchParams.get('token') ?? protocol)
      if (id) this.track(request.socket, id)
    })
    server.on('connection', socket => this.track(socket))
    server.once('close', () => business.emit('close'))
    try { await listenCoreServer(server as Server, '0.0.0.0', this.service.state().port) }
    catch (error) { business.emit('close'); throw error }
    this.tlsServer = server
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TLS 监听失败')
    this.service.setSharing(true, address.port)
    this.discovery = new CoreDiscoveryPublisher(() => this.service.state())
    try { await this.discovery.start() } catch (error) { this.discovery.close(); console.warn('[Core] 局域网发现不可用，仍可使用邀请地址', error) }
  }
  private track(socket: Duplex, id?: string): void {
    let ids = this.sockets.get(socket)
    if (!ids) { ids = new Set(); this.sockets.set(socket, ids); socket.once('close', () => this.sockets.delete(socket)) }
    if (id) ids.add(id)
  }
  private async stopTransport(): Promise<void> {
    this.discovery?.close(); this.discovery = undefined
    const server = this.tlsServer; this.tlsServer = undefined
    if (!server) return
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    for (const socket of this.sockets.keys()) socket.destroy()
    await closed
  }
  async close(): Promise<void> { await this.transition; await this.stopTransport(); this.service.close() }
}
