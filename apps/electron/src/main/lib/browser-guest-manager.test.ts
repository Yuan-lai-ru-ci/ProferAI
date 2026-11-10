import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Session, WebContents, WebPreferences } from 'electron'
import { BrowserGuestManager, type BrowserGuestRequest } from './browser-guest-manager'

class Contents extends EventEmitter {
  destroyed = false
  closes = 0
  url = 'about:blank'
  constructor(readonly id: number, readonly session: Session, readonly hostWebContents: Contents | null = null) { super() }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  close() { this.closes++; this.destroyed = true; this.emit('destroyed') }
  setWindowOpenHandler(_handler: unknown) {}
  asContents() { return this as unknown as WebContents }
}
function harness(timeout = 1000, ready = true) {
  const sessions = new Map<string, Session>()
  const sessionFor = (partition: string): Session => {
    if (!sessions.has(partition)) sessions.set(partition, {} as Session)
    return sessions.get(partition)!
  }
  const owner = new Contents(1, sessionFor('owner'))
  const requests: BrowserGuestRequest[] = []
  const manager = new BrowserGuestManager(owner.asContents(), request => requests.push(request), sessionFor, timeout, ready)
  const will = (request = requests[0]!, src = request.src, partition = request.partition) => {
    let prevented = false
    const preferences: WebPreferences = { preload: '/evil', nodeIntegration: true, sandbox: false, additionalArguments: ['--evil'], webSecurity: false }
    const params = { src, partition }
    owner.emit('will-attach-webview', { preventDefault() { prevented = true } }, preferences, params)
    return { prevented, preferences, params }
  }
  const did = (id = 2, partition = 'persist:test', host = owner, ready = true) => {
    const guest = new Contents(id, sessionFor(partition), host)
    owner.emit('did-attach-webview', {}, guest.asContents())
    if (ready) guest.emit('dom-ready')
    return guest
  }
  const bind = (request: BrowserGuestRequest, guest: Contents) => manager.bindGuest({ sessionId: request.sessionId, tabId: request.tabId, ticket: request.ticket, guestId: guest.id })
  return { manager, owner, requests, will, did, bind, sessionFor }
}

test('精确 marker/partition 放行并覆盖全部偏好，did/ready 本身不认领页面', async () => {
  const h = harness()
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  const request = h.requests[0]!
  expect(request.src).toBe(`about:blank#profer-guest-${request.ticket}`)
  const attempt = h.will()
  expect(attempt.prevented).toBe(false)
  expect(attempt.params.src).toBe('about:blank')
  expect(attempt.preferences.preload).toBeUndefined()
  expect(attempt.preferences.additionalArguments).toBeUndefined()
  expect(attempt.preferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false })
  const guest = h.did()
  expect(h.manager.getBinding(guest.id)).toBeUndefined()
  h.bind(request, guest)
  expect(await result).toMatchObject({ tabId: 't', guest: guest.asContents() })
  expect(h.manager.getBinding(guest.id)?.sessionId).toBe('s')
  h.manager.dispose()
})

test('并发 accepted attach 的 did 顺序可反转，guestId+ticket 显式关联各自页面', async () => {
  const h = harness()
  const first = h.manager.requestGuest('s', 'a', 'persist:test')
  const second = h.manager.requestGuest('s', 'b', 'persist:test')
  expect(h.requests.map(request => request.tabId)).toEqual(['a', 'b'])
  const a = h.requests[0]!, b = h.requests[1]!
  expect(h.will(a).prevented).toBe(false)
  expect(h.will(b).prevented).toBe(false)
  const guestB = h.did(3), guestA = h.did(2)
  h.bind(b, guestB)
  h.bind(a, guestA)
  expect((await first).guest.id).toBe(2)
  expect((await second).guest.id).toBe(3)
  h.manager.dispose()
})

test('错误 marker、后缀、partition 与重放 will 全拒绝', async () => {
  const h = harness()
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  const request = h.requests[0]!
  for (const src of ['about:blank', 'https://example.com', `${request.src}-extra`]) expect(h.will(request, src).prevented).toBe(true)
  expect(h.will(request, request.src, 'persist:other').prevented).toBe(true)
  expect(h.will(request).prevented).toBe(false)
  expect(h.will(request).prevented).toBe(true)
  const guest = h.did()
  h.bind(request, guest)
  await result
  expect(h.will(request).prevented).toBe(true)
  expect(() => h.bind(request, guest)).toThrow('denied')
  h.manager.dispose()
})

test('claim 不允许跨 session/tab/ticket/guestId，并要求初始 dom-ready', async () => {
  const h = harness()
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  const request = h.requests[0]!
  h.will()
  const guest = h.did(2, 'persist:test', h.owner, false)
  expect(() => h.bind(request, guest)).toThrow('denied')
  guest.emit('dom-ready')
  const claim = { sessionId: 's', tabId: 't', ticket: request.ticket, guestId: guest.id }
  for (const bad of [{ sessionId: 'other' }, { tabId: 'other' }, { ticket: 'old' }, { guestId: 99 }]) {
    expect(() => h.manager.bindGuest({ ...claim, ...bad })).toThrow('denied')
  }
  h.bind(request, guest)
  await result
  h.manager.dispose()
})

test('claim 校验真实 guest Session 对象，不靠 renderer 声明 partition', async () => {
  const h = harness()
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  h.will()
  const guest = h.did(2, 'persist:wrong')
  expect(() => h.bind(h.requests[0]!, guest)).toThrow('denied')
  h.manager.release('s', 't')
  await expect(result).rejects.toThrow('released')
  h.manager.dispose()
  expect(guest.destroyed).toBe(true)
})

test('claim 拒绝已离开空白页的 provisional，导航守卫在绑定后才移除', async () => {
  const h = harness()
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  h.will()
  const guest = h.did()
  let blocked = false
  guest.emit('will-frame-navigate', { preventDefault() { blocked = true } })
  expect(blocked).toBe(true)
  expect(h.manager.isProvisional(guest.id)).toBe(true)
  guest.url = 'https://example.com'
  expect(() => h.bind(h.requests[0]!, guest)).toThrow('denied')
  guest.url = 'about:blank'
  h.bind(h.requests[0]!, guest)
  await result
  expect(h.manager.isProvisional(guest.id)).toBe(false)
  expect(guest.listenerCount('will-frame-navigate')).toBe(0)
  h.manager.dispose()
})

test('不同 embedder 的 guest 无法认领本 owner 的票据', async () => {
  const h = harness()
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  h.will()
  const foreignOwner = new Contents(9, h.sessionFor('owner'))
  const foreignGuest = h.did(2, 'persist:test', foreignOwner)
  expect(() => h.bind(h.requests[0]!, foreignGuest)).toThrow('denied')
  expect(foreignGuest.destroyed).toBe(false)
  h.manager.release('s', 't')
  await expect(result).rejects.toThrow('released')
  h.manager.dispose()
})

test('没有 accepted will 或不同 owner 的 did 不获得绑定资格', () => {
  const h = harness()
  expect(h.did().destroyed).toBe(true)
  h.manager.dispose()
})

test('过期或取消的票据不会串到新页，迟到 provisional 有界回收，宿主仍可使用', async () => {
  const h = harness(15)
  const first = h.manager.requestGuest('s', 'old', 'persist:test')
  const old = h.requests[0]!
  h.will(old)
  h.manager.release('s', 'old')
  await expect(first).rejects.toThrow('released')
  const next = h.manager.requestGuest('s', 'new', 'persist:test')
  const request = h.requests[1]!
  h.will(request)
  const lateGuest = h.did(2)
  expect(() => h.bind(old, lateGuest)).toThrow('denied')
  const newGuest = h.did(3)
  h.bind(request, newGuest)
  expect((await next).guest.id).toBe(3)
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(lateGuest.destroyed).toBe(true)
  expect(newGuest.destroyed).toBe(false)
  h.manager.dispose()
})

test('等待 host ready 也有截止时间；未握手不发布票据', async () => {
  const h = harness(5, false)
  const result = h.manager.requestGuest('s', 't', 'persist:test')
  expect(h.requests).toEqual([])
  await expect(result).rejects.toThrow('expired')
  h.manager.setHostReady()
  expect(h.requests).toEqual([])
  h.manager.dispose()
})

test('attach 过期不永久隔离 owner，可签发新 ticket 并正常绑定', async () => {
  const h = harness(10)
  const first = h.manager.requestGuest('s', 't', 'persist:test')
  h.will()
  await expect(first).rejects.toThrow('expired')
  const next = h.manager.requestGuest('s', 't', 'persist:test')
  h.will(h.requests[1]!)
  const guest = h.did()
  h.bind(h.requests[1]!, guest)
  await next
  h.manager.dispose()
})

test('host reset 撤销旧 ticket，旧 guest 延迟回收不误删新绑定', async () => {
  const h = harness()
  const first = h.manager.requestGuest('s', 't', 'persist:test')
  h.will()
  const old = h.did()
  h.bind(h.requests[0]!, old)
  await first
  h.manager.resetHost(true)
  expect(old.destroyed).toBe(false)
  const next = h.manager.requestGuest('s', 't', 'persist:test')
  h.manager.setHostReady()
  expect(old.destroyed).toBe(true)
  h.will(h.requests[1]!)
  const guest = h.did(3)
  h.bind(h.requests[1]!, guest)
  await next
  h.manager.completeHostReset()
  expect(guest.destroyed).toBe(false)
  expect(() => h.bind(h.requests[0]!, guest)).toThrow('denied')
  h.manager.dispose()
})

test('release 后不重复 close；owner 销毁中止全部 pending 并移除监听', async () => {
  const h = harness()
  const first = h.manager.requestGuest('s', 'a', 'persist:test')
  h.will()
  const guest = h.did()
  h.bind(h.requests[0]!, guest)
  await first
  expect(h.manager.release('s', 'a')).toBe(true)
  expect(h.manager.release('s', 'a')).toBe(false)
  expect(guest.closes).toBe(1)
  const pending = h.manager.requestGuest('s', 'b', 'persist:test')
  h.owner.close()
  await expect(pending).rejects.toThrow('reloading')
  await expect(h.manager.requestGuest('s', 'c', 'persist:test')).rejects.toThrow('unavailable')
  expect(h.owner.listenerCount('will-attach-webview')).toBe(0)
})
