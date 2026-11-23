import { createHash, X509Certificate } from 'node:crypto'
import { Agent, request, type RequestOptions } from 'node:https'
import { connect, type ConnectionOptions } from 'node:tls'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import WebSocket from 'ws'
import type { CoreClientOptions, CoreWebSocket } from './core-client'

/** 配对连接只信任已保存的公钥，验证完成后才交出 socket 发送业务凭据。 */
class PinnedAgent extends Agent {
  constructor(private readonly pin: string, keepAlive = true) { super({ keepAlive }) }

  override createConnection(options: RequestOptions, callback?: (err: Error | null, stream: Duplex) => void): undefined {
    if (!callback) throw new Error('Core TLS 缺少连接回调')
    const host = String(options.hostname ?? options.host ?? '')
    const socket = connect({
      ...options,
      host,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    } as ConnectionOptions)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      callback(error, socket)
      socket.destroy()
    }
    socket.once('error', fail)
    socket.setTimeout(5_000, () => fail(new Error('Core TLS 握手超时')))
    socket.once('secureConnect', () => {
      try {
        const cert = new X509Certificate(socket.getPeerCertificate(true).raw)
        const actual = `sha256/${createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`
        if (actual !== this.pin) throw new Error('Core 身份与配对记录不一致，请重新配对')
        if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) throw new Error('Core 身份证书已过期或尚未生效')
        settled = true
        socket.setTimeout(0)
        socket.removeListener('error', fail)
        callback(null, socket)
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }
}

export interface PinnedCoreTransport {
  fetchImpl: NonNullable<CoreClientOptions['fetchImpl']>
  webSocketFactory: NonNullable<CoreClientOptions['webSocketFactory']>
  close(): void
}

export function createPinnedCoreTransport(baseUrl: string, pin: string): PinnedCoreTransport {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin)) throw new Error('Core 配对地址或身份指纹无效')
  const agent = new PinnedAgent(pin)
  // 升级连接不复用 HTTP keep-alive 池，避免把 WS Upgrade 排到已空闲的请求 socket。
  const websocketAgent = new PinnedAgent(pin, false)
  const assertOrigin = (input: string, websocket = false): URL => {
    const url = new URL(input)
    if (url.protocol !== (websocket ? 'wss:' : 'https:') || url.host !== base.host || url.username || url.password) throw new Error('Core 请求地址与配对地址不一致')
    return url
  }
  return {
    async fetchImpl(input, init = {}) {
      const url = assertOrigin(input)
      if (init.body !== undefined && init.body !== null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) throw new Error('Core 请求体格式不支持')
      return new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(new Headers(init.headers).entries())
        const req = request(url, { agent, method: init.method ?? 'GET', headers, signal: init.signal ?? undefined }, res => {
          const chunks: Buffer[] = []
          res.on('data', chunk => chunks.push(Buffer.from(chunk)))
          res.once('error', reject)
          res.once('end', () => {
            const responseHeaders = new Headers()
            for (const [key, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item)
              else if (value !== undefined) responseHeaders.set(key, value)
            }
            const status = res.statusCode ?? 500
            const body = [204, 205, 304].includes(status) || init.method === 'HEAD' ? null : Buffer.concat(chunks)
            resolve(new Response(body, { status, headers: responseHeaders }))
          })
        })
        req.once('error', reject)
        req.end(init.body ?? undefined)
      })
    },
    webSocketFactory(url, options) {
      assertOrigin(url, true)
      return new WebSocket(url, options.protocols, { agent: websocketAgent, headers: options.headers }) as unknown as CoreWebSocket
    },
    close() { agent.destroy(); websocketAgent.destroy() },
  }
}
