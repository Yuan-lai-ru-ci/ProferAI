import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserGuestHost, type BrowserGuestHostBridge } from './BrowserGuestHost'
import { browserGuestHostKey, normalizeBrowserGuestRequests, type BrowserGuestHostRequest } from './BrowserGuestHost.state'

const page: BrowserGuestHostRequest = { sessionId: 's', tabId: 't', ticket: 'ticket', partition: 'persist:browser', src: 'about:blank#profer-guest-ticket' }
describe('稳定 guest 请求快照', () => {
  test('同一票据快照保留对象与节点身份，不因状态同步重载', () => {
    const [next] = normalizeBrowserGuestRequests([page], [{ ...page }])
    expect(next).toBe(page)
    expect(browserGuestHostKey(next!)).toBe(browserGuestHostKey(page))
  })
  test('显式新票据是重建请求，不能偷偷复用已销毁guest', () => {
    const replacement = { ...page, ticket: 'replacement', src: 'about:blank#profer-guest-replacement' }
    expect(normalizeBrowserGuestRequests([page], [replacement])).toEqual([replacement])
  })
  test('session 关闭移除其所有节点，保留另一 session', () => {
    const other = { ...page, sessionId: 'other' }
    expect(normalizeBrowserGuestRequests([page, { ...page, tabId: 't2' }, other], [other])).toEqual([other])
    expect(normalizeBrowserGuestRequests([page], [])).toEqual([])
  })
  test('重复和无效请求不创建额外 guest', () => {
    const other = { ...page, tabId: 't2' }
    expect(normalizeBrowserGuestRequests([], [page, other, page, { ...page, tabId: '' }])).toHaveLength(2)
  })
  test('宿主初始渲染不创建未经握手的 webview', () => {
    const bridge: BrowserGuestHostBridge = {
      connectBrowserGuestHost: async () => [], bindBrowserGuest: async () => {}, onBrowserGuestsChanged: () => () => {}, setBrowserGuestVisibility: () => {},
    }
    const markup = renderToStaticMarkup(createElement(BrowserGuestHost, { bridge }))
    expect(markup).toContain('data-browser-guest-host="connecting"')
    expect(markup).not.toContain('<webview')
  })
  test('组合身份不会因分隔符碰撞', () => {
    expect(browserGuestHostKey({ sessionId: 'a:b', tabId: 'c' })).not.toBe(browserGuestHostKey({ sessionId: 'a', tabId: 'b:c' }))
  })
})
