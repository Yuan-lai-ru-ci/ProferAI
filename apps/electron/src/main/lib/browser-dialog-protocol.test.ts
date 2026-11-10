import { EventEmitter } from 'node:events'
import { expect, test } from 'bun:test'
import type { OnBeforeRequestListenerDetails, Session, WebContents, WebFrameMain } from 'electron'
import { BrowserDialogProtocol, type BrowserDialogRequest } from './browser-dialog-protocol'

function harness() {
  let handle!: (request: Request) => Promise<Response>
  const session = { protocol: { handle: (_scheme: string, handler: typeof handle) => { handle = handler } } }
  const protocol = new BrowserDialogProtocol(session as unknown as Session)
  let current = true
  let destroyed = false
  const top = { url: 'https://example.com/private?secret=x', origin: 'https://example.com', frameTreeNodeId: 1, frameToken: 'document-1', processId: 5, detached: false, isDestroyed: () => false }
  const events = new EventEmitter()
  const contents = { id: 11, mainFrame: top, isDestroyed: () => destroyed, on: events.on.bind(events), removeListener: events.removeListener.bind(events) }
  const requests: BrowserDialogRequest[] = []
  const endpoint = protocol.register({ contents: contents as unknown as WebContents, current: () => current, request: async input => { requests.push(input); return true } })
  const base = endpoint.source.match(/profer-browser-dialog:\/\/[^"\s]+\//)?.[0]
  if (!base) throw new Error('缺少端点')
  let serial = 0
  const payload = JSON.stringify({ type: 'confirm', message: '确认？', defaultPrompt: '' })
  const details = (patch: Partial<OnBeforeRequestListenerDetails> = {}): OnBeforeRequestListenerDetails => ({
    id: ++serial, url: `${base}${serial.toString(16).padStart(32, '0')}`, method: 'POST', resourceType: 'xhr',
    webContentsId: 11, frame: top as unknown as WebFrameMain, uploadData: [{ bytes: Buffer.from(payload) }], referrer: '', timestamp: 0, ...patch,
  })
  const call = (url: string, body = payload): Promise<Response> => handle(new Request(url, { method: 'POST', body }))
  return { protocol, endpoint, contents, top, events, requests, details, call, payload, handle: (request: Request) => handle(request), setCurrent: (value: boolean) => { current = value }, destroy: () => { destroyed = true } }
}

test('只有真实guest/frame的小型POST XHR可授权，handler消费一次性grant', async () => {
  const h = harness()
  const details = h.details()
  expect((await h.call(details.url)).status).toBe(403)
  expect(h.protocol.authorize(details)).toBe(true)
  const response = await h.call(details.url)
  expect(await response.json()).toBe(true)
  expect(h.requests).toEqual([{ type: 'confirm', message: '确认？', defaultPrompt: '', origin: 'https://example.com' }])
  expect(h.protocol.authorize(details)).toBe(false)
  expect((await h.call(details.url)).status).toBe(403)
  h.endpoint.dispose()
})

test('错误guest/其他frame/非XHR/导航/GET/文件上传/超大payload均拒绝', () => {
  const h = harness()
  expect(h.protocol.authorize(h.details({ webContentsId: 99 }))).toBe(false)
  expect(h.protocol.authorize(h.details({ frame: { ...h.top, top: {} } as unknown as WebFrameMain }))).toBe(false)
  expect(h.protocol.authorize(h.details({ resourceType: 'mainFrame' }))).toBe(false)
  expect(h.protocol.authorize(h.details({ method: 'GET' }))).toBe(false)
  expect(h.protocol.authorize(h.details({ frame: null }))).toBe(false)
  expect(h.protocol.authorize(h.details({ uploadData: [{ file: '/never-read', bytes: Buffer.alloc(0) }] }))).toBe(false)
  expect(h.protocol.authorize(h.details({ uploadData: [{ bytes: Buffer.alloc(128001) }] }))).toBe(false)
  const valid = h.details()
  expect(h.protocol.authorize({ ...valid, url: `${valid.url}?type=confirm` })).toBe(false)
  expect(h.protocol.authorize({ ...valid, url: valid.url.replace(/\/[0-9a-f]+$/, '/') })).toBe(false)
  h.endpoint.dispose()
})

test('跨源子frame来源取Electron，不信任payload自报；不泄漏URL查询', async () => {
  const h = harness()
  const child = { ...h.top, top: h.top, origin: 'https://child.example.com', url: 'https://child.example.com/page?secret' }
  const details = h.details({ frame: child as unknown as WebFrameMain })
  expect(h.protocol.authorize(details)).toBe(true)
  await h.call(details.url, JSON.stringify({ type: 'confirm', message: '内容', defaultPrompt: '', origin: 'https://forged.test' }))
  expect(h.requests[0]?.origin).toBe('https://child.example.com')
  h.endpoint.dispose()
})

test('授权后页面实例失效、frame重载或端点释放，handler不向新页面转交请求', async () => {
  const h = harness()
  const a = h.details()
  expect(h.protocol.authorize(a)).toBe(true)
  h.top.frameToken = 'document-2'
  expect((await h.call(a.url)).status).toBe(403)
  const b = h.details()
  expect(h.protocol.authorize(b)).toBe(true)
  h.setCurrent(false)
  expect((await h.call(b.url)).status).toBe(403)
  h.setCurrent(true)
  const c = h.details()
  expect(h.protocol.authorize(c)).toBe(true)
  h.endpoint.dispose()
  expect((await h.call(c.url)).status).toBe(403)
  expect(h.protocol.authorize(h.details())).toBe(false)
  expect(h.requests).toHaveLength(0)
})

test('同URL重载也失效旧grant，同文档跳转保留，子frame导航不误伤主frame', async () => {
  const h = harness()
  const main = h.details()
  expect(h.protocol.authorize(main)).toBe(true)
  h.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, frame: h.top })
  expect((await h.call(main.url)).status).toBe(403)
  const sameDocument = h.details()
  expect(h.protocol.authorize(sameDocument)).toBe(true)
  h.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, frame: h.top })
  expect((await h.call(sameDocument.url)).status).toBe(200)
  const child = { ...h.top, frameTreeNodeId: 2, top: h.top }
  const childRequest = h.details({ frame: child as unknown as WebFrameMain })
  const mainRequest = h.details()
  expect(h.protocol.authorize(childRequest)).toBe(true)
  expect(h.protocol.authorize(mainRequest)).toBe(true)
  h.events.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, frame: child })
  expect((await h.call(childRequest.url)).status).toBe(403)
  expect((await h.call(mainRequest.url)).status).toBe(200)
  h.endpoint.dispose()
  expect(h.events.listenerCount('did-start-navigation')).toBe(0)
})

test('未知对话框类型与越界正文返回400，不创建UI请求', async () => {
  const h = harness()
  for (const payload of [{ type: 'execute', message: '', defaultPrompt: '' }, { type: 'prompt', message: 'x'.repeat(8001), defaultPrompt: '' }, { type: 'alert', message: 'x' }]) {
    const details = h.details()
    expect(h.protocol.authorize(details)).toBe(true)
    expect((await h.call(details.url, JSON.stringify(payload))).status).toBe(400)
  }
  expect(h.requests).toHaveLength(0)
  h.endpoint.dispose()
})
