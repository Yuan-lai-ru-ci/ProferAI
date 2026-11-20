import { randomUUID } from 'node:crypto'

export type DesktopHostOperation = 'preview.open' | 'preview.inspect' | 'clipboard.write'
export interface DesktopHostIdentity { coreId: string; sessionId: string; runId: string }
export interface DesktopHostRequest extends DesktopHostIdentity {
  requestId: string
  operation: DesktopHostOperation
  payload: unknown
}
export type DesktopHostResponse = DesktopHostIdentity & { requestId: string } & (
  | { ok: true; value: unknown }
  | { ok: false; error: string }
)
export interface DesktopHostBridgePolicy {
  /** 每次派发与响应均核验当前 Core 的运行所有权。 */
  isRunActive(identity: DesktopHostIdentity): boolean
  /** 由 Core 的统一权限服务决定，不接受桌面传回的 allow 标志。 */
  authorize(request: Omit<DesktopHostRequest, 'requestId'>, signal: AbortSignal): Promise<boolean>
}
interface PendingRequest {
  request: DesktopHostRequest
  connectionId: string
  finish(error?: Error, value?: unknown): void
}

/** Gateway 只可向已鉴权的桌面连接注册；连接 ID 必须由服务器生成，不能取客户端输入。 */
export class CoreDesktopHostBridge {
  private readonly hosts = new Map<string, (request: DesktopHostRequest) => void>()
  private readonly pending = new Map<string, PendingRequest>()
  constructor(readonly coreId: string, private readonly policy: DesktopHostBridgePolicy, private readonly timeoutMs = 30_000) {
    if (!coreId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('宿主桥接配置无效')
  }

  attach(connectionId: string, send: (request: DesktopHostRequest) => void): () => void {
    if (!connectionId || this.hosts.has(connectionId)) throw new Error('桌面连接身份为空或已注册')
    this.hosts.set(connectionId, send)
    return () => {
      if (this.hosts.get(connectionId) !== send) return
      this.hosts.delete(connectionId)
      for (const pending of this.pending.values()) {
        if (pending.connectionId === connectionId) pending.finish(new Error('桌面宿主已断连'))
      }
    }
  }

  isConnected(connectionId: string): boolean { return this.hosts.has(connectionId) }

  async request(input: { connectionId: string; sessionId: string; runId: string; operation: DesktopHostOperation; payload: unknown; signal: AbortSignal }): Promise<unknown> {
    const send = this.hosts.get(input.connectionId)
    if (!send) throw new Error('桌面宿主未连接，不会回落本机执行')
    const request: DesktopHostRequest = { coreId: this.coreId, sessionId: input.sessionId, runId: input.runId,
      requestId: randomUUID(), operation: input.operation, payload: structuredClone(input.payload) }
    if (!['preview.open', 'preview.inspect', 'clipboard.write'].includes(request.operation)) throw new Error('不支持的桌面宿主操作')
    const assertActive = (): void => {
      if (input.signal.aborted || !request.sessionId || !request.runId || !this.policy.isRunActive(request)) throw new Error('宿主请求的运行已结束或身份无效')
      if (this.hosts.get(input.connectionId) !== send) throw new Error('桌面宿主连接已改变')
    }
    assertActive()
    if (!await this.policy.authorize(request, input.signal)) throw new Error('Core 拒绝了桌面宿主操作')
    assertActive()
    return new Promise((resolve, reject) => {
      let settled = false
      const onAbort = (): void => finish(new Error('宿主请求已中止'))
      const timer = setTimeout(() => finish(new Error('桌面宿主响应超时')), this.timeoutMs)
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal.removeEventListener('abort', onAbort)
        this.pending.delete(request.requestId)
        if (error) reject(error)
        else resolve(value)
      }
      this.pending.set(request.requestId, { request, connectionId: input.connectionId, finish })
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (input.signal.aborted) { onAbort(); return }
      try { send(request) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  respond(connectionId: string, response: DesktopHostResponse): boolean {
    if (!response || typeof response !== 'object' || typeof response.requestId !== 'string' || typeof response.ok !== 'boolean') return false
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.connectionId !== connectionId || !this.hosts.has(connectionId)) return false
    const expected = pending.request
    if (response.coreId !== this.coreId || response.sessionId !== expected.sessionId || response.runId !== expected.runId) return false
    if (!this.policy.isRunActive(expected)) { pending.finish(new Error('响应所属运行已结束')); return false }
    if (response.ok) pending.finish(undefined, response.value)
    else pending.finish(new Error(typeof response.error === 'string' ? response.error.slice(0, 2000) : '桌面宿主操作失败'))
    return true
  }

  invalidateRun(sessionId: string, runId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId === sessionId && pending.request.runId === runId) pending.finish(new Error('宿主请求所属运行已结束'))
    }
  }

  dispose(): void {
    this.hosts.clear()
    for (const pending of this.pending.values()) pending.finish(new Error('Core 宿主桥接已关闭'))
  }
}
