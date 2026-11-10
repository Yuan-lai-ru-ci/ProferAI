import { randomUUID } from 'node:crypto'
import type { Event, Session, WebContents, WebPreferences } from 'electron'
import type { BrowserGuestClaim, BrowserGuestRequest } from '@profer/shared'

export type { BrowserGuestRequest } from '@profer/shared'
export interface BrowserGuestBinding extends BrowserGuestRequest { guest: WebContents }

interface Permit {
  request: BrowserGuestRequest
  accepted: boolean
  emitted: boolean
  timer: ReturnType<typeof setTimeout>
  resolve: (binding: BrowserGuestBinding) => void
  reject: (error: Error) => void
}
interface ProvisionalGuest {
  guest: WebContents
  ready: boolean
  timer: ReturnType<typeof setTimeout>
  removeGuards: () => void
}

/** did-attach 不携带页面身份；先停在空白页，待可信 DOM host 以 guestId + 一次性票据认领。 */
export class BrowserGuestManager {
  private readonly permits = new Map<string, Permit>()
  private readonly provisional = new Map<number, ProvisionalGuest>()
  private readonly bindings = new Map<number, BrowserGuestBinding>()
  private readonly retiring = new Set<WebContents>()
  private hostReady: boolean
  private disposed = false

  constructor(
    private readonly owner: WebContents,
    private readonly emitRequest: (request: BrowserGuestRequest) => void,
    private readonly sessionForPartition: (partition: string) => Session,
    private readonly timeoutMs = 10_000,
    initiallyReady = true,
  ) {
    this.hostReady = initiallyReady
    owner.on('will-attach-webview', this.onWillAttach)
    owner.on('did-attach-webview', this.onDidAttach)
    owner.once('destroyed', this.onDestroyed)
  }

  setHostReady(): void {
    if (this.disposed || this.owner.isDestroyed()) throw new Error('Guest owner unavailable')
    this.completeHostReset()
    this.hostReady = true
    for (const permit of this.permits.values()) this.publish(permit)
  }

  requestGuest(sessionId: string, tabId: string, partition: string): Promise<BrowserGuestBinding> {
    if (this.disposed || this.owner.isDestroyed()) return Promise.reject(new Error('Guest owner unavailable'))
    if (!sessionId || !tabId || !partition) return Promise.reject(new Error('Invalid guest request'))
    const samePage = (request: BrowserGuestRequest): boolean => request.sessionId === sessionId && request.tabId === tabId
    if ([...this.permits.values()].some(permit => samePage(permit.request)) || [...this.bindings.values()].some(samePage)) {
      return Promise.reject(new Error('Guest tab already pending or bound'))
    }
    const ticket = randomUUID()
    const request = { sessionId, tabId, partition, ticket, src: `about:blank#profer-guest-${ticket}` }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.permits.delete(ticket)
        reject(new Error('Guest request expired'))
      }, this.timeoutMs)
      const permit: Permit = { request, accepted: false, emitted: false, timer, resolve, reject }
      this.permits.set(ticket, permit)
      this.publish(permit)
    })
  }

  /** 仅顶层宿主 IPC 调用；不接受 did 事件顺序作为页面身份。 */
  bindGuest(claim: BrowserGuestClaim): void {
    const permit = this.permits.get(claim.ticket)
    const pending = this.provisional.get(claim.guestId)
    if (this.disposed || !this.hostReady || !permit?.accepted || !pending?.ready
      || permit.request.sessionId !== claim.sessionId || permit.request.tabId !== claim.tabId
      || pending.guest.isDestroyed() || pending.guest.hostWebContents !== this.owner
      || pending.guest.getURL() !== 'about:blank'
      || pending.guest.session !== this.sessionForPartition(permit.request.partition)) {
      throw new Error('Guest binding denied: invalid, expired or mismatched ticket')
    }
    this.permits.delete(claim.ticket)
    clearTimeout(permit.timer)
    this.provisional.delete(claim.guestId)
    clearTimeout(pending.timer)
    pending.removeGuards()
    const binding = { ...permit.request, guest: pending.guest }
    this.bindings.set(claim.guestId, binding)
    permit.resolve(binding)
  }

  /** 返回 true 表示 manager 已接管该页面的回收，调用方不得再 close 一遍。 */
  release(sessionId: string, tabId: string): boolean {
    for (const [ticket, permit] of this.permits) {
      if (permit.request.sessionId !== sessionId || permit.request.tabId !== tabId) continue
      this.permits.delete(ticket)
      clearTimeout(permit.timer)
      permit.reject(new Error('Guest request released'))
      return true
    }
    for (const [id, binding] of this.bindings) {
      if (binding.sessionId !== sessionId || binding.tabId !== tabId) continue
      this.bindings.delete(id)
      if (!binding.guest.isDestroyed()) binding.guest.close()
      return true
    }
    return false
  }

  listBindings(): BrowserGuestBinding[] { return [...this.bindings.values()] }
  getBinding(id: number): BrowserGuestBinding | undefined { return this.bindings.get(id) }
  isProvisional(id: number | undefined): boolean { return id !== undefined && this.provisional.has(id) }

  /** 撤销旧代际全部票据；重载期间由 Electron 拆 DOM，余下 guest 等新 host 连接后回收。 */
  resetHost(deferGuestClose = false): void {
    this.hostReady = false
    for (const permit of this.permits.values()) {
      clearTimeout(permit.timer)
      permit.reject(new Error('Guest host is reloading'))
    }
    this.permits.clear()
    for (const pending of this.provisional.values()) {
      clearTimeout(pending.timer)
      this.retiring.add(pending.guest)
    }
    this.provisional.clear()
    for (const binding of this.bindings.values()) this.retiring.add(binding.guest)
    this.bindings.clear()
    if (!deferGuestClose) this.completeHostReset()
  }

  completeHostReset(): void {
    const guests = [...this.retiring]
    this.retiring.clear()
    for (const guest of guests) if (!guest.isDestroyed()) guest.close()
  }

  private publish(permit: Permit): void {
    if (!this.hostReady || permit.emitted || this.disposed) return
    permit.emitted = true
    try { this.emitRequest({ ...permit.request }) } catch (error) {
      this.permits.delete(permit.request.ticket)
      clearTimeout(permit.timer)
      permit.reject(error instanceof Error ? error : new Error('Guest request delivery failed'))
    }
  }

  private readonly onWillAttach = (event: Event, preferences: WebPreferences, params: Record<string, string>): void => {
    const permit = [...this.permits.values()].find(item => item.request.src === params.src)
    if (this.disposed || !this.hostReady || !permit?.emitted || permit.accepted || params.partition !== permit.request.partition) {
      event.preventDefault()
      return
    }
    for (const key of Object.keys(preferences)) delete (preferences as Record<string, unknown>)[key]
    Object.assign(preferences, {
      partition: permit.request.partition, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false,
    })
    params.src = 'about:blank'
    permit.accepted = true
  }

  private readonly onDidAttach = (_event: Event, guest: WebContents): void => {
    const id = guest.id
    if (this.disposed || !this.hostReady || guest.hostWebContents !== this.owner || guest.isDestroyed()
      || this.bindings.has(id) || this.provisional.has(id)
      || ![...this.permits.values()].some(permit => permit.accepted)) {
      if (guest.hostWebContents === this.owner && !this.bindings.has(id) && !this.provisional.has(id) && !guest.isDestroyed()) guest.close()
      return
    }
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    const blockNavigation = (event: Event): void => event.preventDefault()
    guest.on('will-navigate', blockNavigation)
    guest.on('will-frame-navigate', blockNavigation)
    guest.on('will-redirect', blockNavigation)
    const removeGuards = (): void => {
      guest.removeListener('will-navigate', blockNavigation)
      guest.removeListener('will-frame-navigate', blockNavigation)
      guest.removeListener('will-redirect', blockNavigation)
    }
    const timer = setTimeout(() => {
      this.provisional.delete(id)
      removeGuards()
      if (!guest.isDestroyed()) guest.close()
    }, this.timeoutMs)
    const pending = { guest, ready: false, timer, removeGuards }
    this.provisional.set(id, pending)
    guest.once('dom-ready', () => { pending.ready = true })
    guest.once('destroyed', () => {
      clearTimeout(timer)
      removeGuards()
      this.provisional.delete(id)
      this.bindings.delete(id)
      this.retiring.delete(guest)
    })
  }

  private readonly onDestroyed = (): void => this.dispose()
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resetHost()
    this.owner.removeListener('will-attach-webview', this.onWillAttach)
    this.owner.removeListener('did-attach-webview', this.onDidAttach)
    this.owner.removeListener('destroyed', this.onDestroyed)
  }
}
