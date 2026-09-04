declare module 'ws' {
  import { EventEmitter } from 'node:events'
  import type { Server as HttpServer, IncomingMessage } from 'node:http'

  export default class WebSocket extends EventEmitter {
    static readonly OPEN: number
    static readonly CONNECTING: number
    static readonly CLOSING: number
    static readonly CLOSED: number
    readonly readyState: number
    constructor(url: string, options?: { headers?: Record<string, string> })
    send(data: Buffer | ArrayBuffer | Uint8Array | string): void
    close(code?: number, reason?: string): void
    terminate(): void
    on(event: string, listener: (...args: never[]) => void): this
  }

  /** WebSocket 收到的消息原始数据 */
  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>
    constructor(options?: { server?: HttpServer; path?: string })
    close(cb?: () => void): void
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this
    on(event: string, listener: (...args: never[]) => void): this
  }
}
