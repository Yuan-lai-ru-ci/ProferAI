import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { BrowserController } from './browser-controller'

test('关闭最后一个标签时释放guest和DOM请求，不创建残留原生命中区域', async () => {
  const sent: unknown[][] = []
  let closed = 0
  const contents = {
    debugger: { isAttached: () => false, detach: () => undefined },
    isDestroyed: () => false,
    close: () => { closed++ },
    once: () => undefined,
  }
  const tab = { tabId: 'tab-1', contents, state: { visible: true } }
  const browserSession = {
    sessionId: 'session-1', tabs: new Map([[tab.tabId, tab]]), activeTabId: tab.tabId,
    agentTabId: tab.tabId,
  }
  const owner = { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { sent.push(args) } } }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    foregroundSessionId: string | null
    sessions: Map<string, typeof browserSession>
    guestRequests: Map<string, { sessionId: string; tabId: string }>
  }
  internals.owner = owner
  internals.foregroundSessionId = browserSession.sessionId
  internals.sessions.set(browserSession.sessionId, browserSession)
  internals.guestRequests.set(JSON.stringify([browserSession.sessionId, tab.tabId]), { sessionId: browserSession.sessionId, tabId: tab.tabId })
  expect(await controller.closeTab(browserSession.sessionId, tab.tabId)).toBeNull()
  expect(controller.getState(browserSession.sessionId)).toBeNull()
  expect(internals.foregroundSessionId).toBe(browserSession.sessionId)
  expect(internals.guestRequests.size).toBe(0)
  expect(sent.at(-1)?.[1]).toEqual([])
  expect(closed).toBe(1)
})

test('销毁回调不重新读取已经失效的 WebContents.debugger getter', () => {
  const events = new EventEmitter()
  const debuggerEvents = new EventEmitter()
  const debuggerClient = Object.assign(debuggerEvents, {
    attach: () => undefined,
    sendCommand: async () => ({}),
  })
  let destroyed = false
  const contents = {
    id: 123,
    get debugger() {
      if (destroyed) throw new Error('Object has been destroyed')
      return debuggerClient
    },
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    setWindowOpenHandler: () => undefined,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    installTabContents: (session: { sessionId: string }, tab: { tabId: string }, contents: WebContents) => void
  }
  internals.installTabContents({ sessionId: 'closed-session' }, { tabId: 'closed-tab' }, contents as unknown as WebContents)
  expect(debuggerClient.listenerCount('message')).toBe(1)
  destroyed = true
  expect(() => events.emit('destroyed')).not.toThrow()
  expect(debuggerClient.listenerCount('message')).toBe(0)
})

test('旧 ticket 的迟到可见性清理不影响重建后的 guest', () => {
  const controller = new BrowserController()
  const tab = { tabId: 't', state: { visible: true } }
  const browserSession = { sessionId: 's', tabs: new Map([['t', tab]]) }
  const internals = controller as unknown as {
    sessions: Map<string, typeof browserSession>
    guestRequests: Map<string, { ticket: string }>
    emit: () => void
  }
  let changes = 0
  internals.sessions.set('s', browserSession)
  internals.guestRequests.set(JSON.stringify(['s', 't']), { ticket: 'new' })
  internals.emit = () => { changes++ }
  controller.setGuestVisibility([{ sessionId: 's', tabId: 't', ticket: 'old', visible: false }])
  expect(tab.state.visible).toBe(true)
  expect(changes).toBe(0)
  controller.setGuestVisibility([{ sessionId: 's', tabId: 't', ticket: 'new', visible: false }])
  expect(tab.state.visible).toBe(false)
  expect(changes).toBe(1)
})

test('用户输入可激活另一可见网页；脚本 focus、后台页、失焦窗口与 Agent 输入都不授予展示权', () => {
  const events = new EventEmitter()
  const debug = Object.assign(new EventEmitter(), { attach: () => undefined, sendCommand: async () => ({}) })
  const contents = { id: 321, debugger: debug, on: events.on.bind(events), removeListener: events.removeListener.bind(events), setWindowOpenHandler: () => undefined }
  const sent: unknown[][] = []
  let focused = true
  const tab = { tabId: 'work', contents, state: { visible: true } }
  const session = { sessionId: 's', activeTabId: 'user', tabs: new Map([['work', tab]]) }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: unknown; foregroundSessionId: string; guestManager: unknown
    sessions: Map<string, typeof session>
    agentOperatingTabs: Map<string, number>
    installTabContents: (session: unknown, tab: unknown, contents: WebContents) => void
    markUserBrowserContext: () => void
    activateDisplayTab: (targetSession: typeof session, page: typeof tab) => void
  }
  internals.owner = { isDestroyed: () => false, isVisible: () => true, isFocused: () => focused,
    webContents: { send: (...args: unknown[]) => { sent.push(args) } } }
  internals.foregroundSessionId = 's'
  internals.sessions.set('s', session)
  internals.guestManager = { getBinding: () => ({ sessionId: 's', tabId: 'work' }) }
  internals.markUserBrowserContext = () => undefined
  internals.activateDisplayTab = (targetSession, page) => { targetSession.activeTabId = page.tabId }
  internals.installTabContents(session, tab, contents as unknown as WebContents)
  events.emit('focus')
  expect(session.activeTabId).toBe('user')
  events.emit('before-mouse-event', {}, { type: 'mouseDown' })
  expect(session.activeTabId).toBe('work')
  expect(sent).toHaveLength(1)
  session.activeTabId = 'user'; sent.length = 0
  internals.agentOperatingTabs.set('s:work', 1)
  events.emit('before-input-event', {}, { type: 'keyDown' })
  expect(sent).toHaveLength(0)
  internals.agentOperatingTabs.clear()
  focused = false
  events.emit('before-mouse-event', {}, { type: 'mouseDown' })
  expect(sent).toHaveLength(0)
  focused = true; tab.state.visible = false
  events.emit('before-mouse-event', {}, { type: 'mouseDown' })
  expect(sent).toHaveLength(0)
  expect(session.activeTabId).toBe('user')
})

test('没有浏览器会话时 listTabs 只读：不创建 session/tab，也不广播状态', () => {
  const sent: unknown[] = []
  const owner = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => { sent.push(args) } },
    contentView: {
      // 创建原生视图即视为副作用：这里直接失败，确保只读查询不会走到 createSession。
      addChildView: () => { throw new Error('listTabs 不应创建原生浏览器视图') },
      removeChildView: () => undefined,
    },
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    sessions: Map<string, unknown>
  }
  internals.owner = owner

  const result = controller.listTabs('session-without-browser')

  expect(result).toEqual({
    sessionId: 'session-without-browser',
    exists: false,
    activeTabId: null,
    agentTabId: null,
    tabs: [],
  })
  expect(internals.sessions.size).toBe(0)
  expect(sent).toEqual([])
})

test('已有浏览器会话时 listTabs 只投影现有标签：不新建标签、不广播状态', () => {
  const sent: unknown[] = []
  const owner = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => { sent.push(args) } },
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  }
  const agentTab = {
    tabId: 'tab-agent',
    state: { url: 'https://example.com/', title: '示例页', loading: false },
    zoomFactor: 1,
    openedByAgent: true,
  }
  const userTab = {
    tabId: 'tab-user',
    state: { url: '', title: '新建标签页', loading: true },
    zoomFactor: 1.25,
    openedByAgent: false,
  }
  const browserSession = {
    sessionId: 'session-1',
    tabs: new Map([[agentTab.tabId, agentTab], [userTab.tabId, userTab]]),
    activeTabId: userTab.tabId,
    agentTabId: agentTab.tabId,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    sessions: Map<string, typeof browserSession>
  }
  internals.owner = owner
  internals.sessions.set(browserSession.sessionId, browserSession)

  const result = controller.listTabs(browserSession.sessionId)

  expect(result.exists).toBe(true)
  expect(result.activeTabId).toBe('tab-user')
  expect(result.agentTabId).toBe('tab-agent')
  expect(result.tabs.map((tab) => tab.tabId)).toEqual(['tab-agent', 'tab-user'])
  expect(result.tabs[0]).toMatchObject({ tabId: 'tab-agent', url: 'https://example.com/', title: '示例页', openedByAgent: true })
  expect(result.tabs[1]).toMatchObject({ tabId: 'tab-user', zoomFactor: 1.25, openedByAgent: false })
  // 原有标签未被回收或新增，也没有任何状态推送。
  expect(browserSession.tabs.size).toBe(2)
  expect(sent).toEqual([])
})

test('会话记录存在但 activeTabId 已失效时 listTabs 返回可判定的空值', () => {
  const owner = {
    isDestroyed: () => false,
    webContents: { send: () => undefined },
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  }
  const staleTab = {
    tabId: 'tab-closing',
    state: { url: '', title: '关闭中', loading: false },
    zoomFactor: 1,
    openedByAgent: true,
  }
  const browserSession = {
    sessionId: 'session-stale',
    tabs: new Map([[staleTab.tabId, staleTab]]),
    activeTabId: 'tab-already-disposed',
    agentTabId: null,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    sessions: Map<string, typeof browserSession>
  }
  internals.owner = owner
  internals.sessions.set(browserSession.sessionId, browserSession)

  const result = controller.listTabs(browserSession.sessionId)

  expect(result.exists).toBe(true)
  expect(result.activeTabId).toBeNull()
  expect(result.agentTabId).toBeNull()
  expect(result.tabs.map((tab) => tab.tabId)).toEqual(['tab-closing'])
})
