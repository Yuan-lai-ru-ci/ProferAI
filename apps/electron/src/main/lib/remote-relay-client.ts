/**
 * Profer 桌面端 → 中心 Remote Relay outbound client。
 *
 * 该模块只负责传输层：ticket 获取、WSS 重连和帧收发；命令执行和事件生产
 * 由 remote-service 通过回调提供，避免把 Agent/模型/文件权限移到服务器。
 */
import WebSocket from 'ws'
import { getRemoteRelayTicket } from './auth-service'

export const DEFAULT_REMOTE_RELAY_URL = 'wss://profer.cn/remote/ws'

export type RemoteRelayClientOptions = {
  url?: string
  enabled?: boolean
  onOpen?: (sink: RemoteRelaySink) => void
  onClose?: () => void
  onMessage?: (raw: string, sink: RemoteRelaySink) => void
}

export type RemoteRelaySink = {
  send: (data: string) => boolean
  isOpen: () => boolean
  close: (code?: number, reason?: string) => void
}

const RECONNECT_MIN_MS = 2000
const RECONNECT_MAX_MS = 30000
const TICKET_REFRESH_MARGIN_MS = 15000

export class RemoteRelayClient {
  private readonly url: string
  private readonly options: RemoteRelayClientOptions
  private ws: WebSocket | null = null
  private sink: RemoteRelaySink | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private reconnectDelay = RECONNECT_MIN_MS
  private generation = 0

  constructor(options: RemoteRelayClientOptions = {}) {
    this.url = options.url || process.env.PROFER_REMOTE_RELAY_URL || DEFAULT_REMOTE_RELAY_URL
    this.options = options
  }

  start(): void {
    if (this.options.enabled === false || this.stopped === false) return
    this.stopped = false
    this.reconnectDelay = RECONNECT_MIN_MS
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.generation++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.reconnectTimer = null
    this.refreshTimer = null
    this.sink = null
    try { this.ws?.close(1000, 'client stopped') } catch { /* ignore */ }
    this.ws = null
  }

  getSink(): RemoteRelaySink | null {
    return this.sink
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    let ticket: { ticket: string; expiresAt: number }
    try {
      ticket = await getRemoteRelayTicket('desktop')
    } catch (error) {
      console.warn('[Remote Relay] 获取 desktop ticket 失败:', error instanceof Error ? error.message : error)
      this.scheduleReconnect()
      return
    }
    if (this.stopped || generation !== this.generation) return

    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, { headers: { Origin: 'https://profer.cn' } })
    } catch (error) {
      console.warn('[Remote Relay] 创建 WSS 失败:', error)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    const relaySocket = ws as WebSocket & { bufferedAmount: number }
    const sink: RemoteRelaySink = {
      send: (data) => {
        if (relaySocket.readyState !== WebSocket.OPEN) return false
        if (relaySocket.bufferedAmount >= 4 * 1024 * 1024) {
          try { relaySocket.close(1013, 'slow relay client') } catch { /* ignore */ }
          return false
        }
        if (Buffer.byteLength(data) > 256 * 1024) return false
        relaySocket.send(data)
        return true
      },
      isOpen: () => relaySocket.readyState === WebSocket.OPEN,
      close: (code, reason) => { try { relaySocket.close(code, reason) } catch { /* ignore */ } },
    }
    this.sink = sink

    ws.once('open', () => {
      if (this.stopped || this.ws !== ws) return
      ws.send(JSON.stringify({ kind: 'relay_auth', ticket: ticket.ticket }))
      this.reconnectDelay = RECONNECT_MIN_MS
      this.scheduleTicketRefresh(ticket.expiresAt)
      this.options.onOpen?.(sink)
    })
    ws.on('message', (raw: unknown) => {
      if (this.stopped || this.ws !== ws) return
      this.options.onMessage?.(String(raw), sink)
    })
    ws.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[Remote Relay] WSS 错误:', message)
    })
    ws.once('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.sink = null
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      this.options.onClose?.()
      this.scheduleReconnect()
    })
  }

  private scheduleTicketRefresh(expiresAt: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const delay = Math.max(1000, expiresAt - Date.now() - TICKET_REFRESH_MARGIN_MS)
    this.refreshTimer = setTimeout(() => {
      // 不把 ticket 发送到已建立的连接；短 ticket 到期前主动换连接。
      try { this.ws?.close(4001, 'refreshing relay ticket') } catch { /* ignore */ }
    }, delay)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }
}
