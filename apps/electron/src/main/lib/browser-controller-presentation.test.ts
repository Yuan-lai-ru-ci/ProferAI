import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserTabState } from '@profer/shared'
import { BrowserController } from './browser-controller'

/** 只检查目标所有权与结果投影；真实页面合成、焦点和网络由 Electron smoke 覆盖。 */
function harness() {
  const makeTab = (tabId: string, visible = false) => ({
    tabId,
    lastActivityAt: 0,
    zoomFactor: 1,
    openedByAgent: !visible,
    state: {
      tabId, url: `https://example.com/${tabId}`, title: tabId, localFile: null,
      loading: false, visible, canGoBack: true, canGoForward: false,
      zoomFactor: 1, translated: false, loadError: null, trace: [],
    } satisfies BrowserTabState,
  })
  const display = makeTab('user-page', true)
  const work = makeTab('work-page')
  const browserSession = {
    sessionId: 'session-1',
    tabs: new Map([[display.tabId, display], [work.tabId, work]]),
    activeTabId: display.tabId,
    agentTabId: work.tabId as string | null,
    tabMru: [display.tabId, work.tabId],
    ledger: [],
    allowedRoots: [] as string[],
    executionSource: 'user',
    agentAbortController: new AbortController(),
  }
  const activated: string[] = []
  const loaded: string[] = []
  let focused = true
  const controller = new BrowserController()
  const internals = controller as unknown as {
    agentOperatingTabs: Map<string, number>
    sessions: Map<string, typeof browserSession>
    foregroundSessionId: string | null
    owner: unknown
    assertRiskDisclaimerAcknowledged: () => void
    emit: () => void
    trace: () => void
    markUserBrowserContext: () => void
    reclaimExcessAgentTabs: () => number
    createTab: (session: typeof browserSession, preview?: boolean, claimAsAgent?: boolean) => typeof display
    activateDisplayTab: (session: typeof browserSession, tab: typeof display) => void
    loadUrl: (tab: typeof display, url: string) => Promise<void>
    updateNavigationState: () => void
    runTabOperation: <T>(session: unknown, tab: unknown, signal: unknown, task: (signal?: AbortSignal) => Promise<T>) => Promise<T>
    openExternalLinkInDisplayTab: (session: typeof browserSession, source: typeof display, url: string) => Promise<void>
  }
  internals.sessions.set(browserSession.sessionId, browserSession)
  internals.foregroundSessionId = browserSession.sessionId
  internals.owner = { isDestroyed: () => false, isVisible: () => true, isFocused: () => focused }
  internals.assertRiskDisclaimerAcknowledged = () => undefined
  internals.emit = () => undefined
  internals.trace = () => undefined
  internals.markUserBrowserContext = () => undefined
  internals.reclaimExcessAgentTabs = () => 0
  internals.loadUrl = async (tab, url) => { loaded.push(url); tab.state.url = url }
  internals.updateNavigationState = () => undefined
  internals.runTabOperation = async (_session, _tab, _signal, task) => task()
  internals.createTab = (session, _preview, claimAsAgent) => {
    const tab = makeTab('new-page')
    tab.openedByAgent = claimAsAgent === true
    session.tabs.set(tab.tabId, tab)
    if (!session.activeTabId) session.activeTabId = tab.tabId
    if (claimAsAgent) session.agentTabId = tab.tabId
    return tab
  }
  internals.activateDisplayTab = (session, tab) => {
    activated.push(tab.tabId)
    session.activeTabId = tab.tabId
  }
  return {
    controller, browserSession, activated, loaded, display, work,
    setFocused: (value: boolean) => { focused = value },
    markAgentOperating: (tabId: string) => internals.agentOperatingTabs.set(`session-1:${tabId}`, 1),
    popup: (source: typeof display) => internals.openExternalLinkInDisplayTab(browserSession, source, 'http://127.0.0.1/popup'),
  }
}

test('Given 用户正在看页面 When Agent 新建工作标签 Then 不切换用户展示页或原生可见性', async () => {
  const h = harness()
  const result = await h.controller.createNewTab('session-1')
  expect(h.browserSession.agentTabId).toBe('new-page')
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.browserSession.tabMru).toEqual(['user-page', 'work-page'])
  expect(h.activated).toEqual([])
  expect(result).toMatchObject({ tabId: 'new-page', activeTabId: 'user-page', url: 'https://example.com/new-page' })
  expect(h.controller.getState('session-1')).toMatchObject({ activeTabId: 'user-page', url: 'https://example.com/user-page' })
})

test('Given 用户正在看页面 When Agent 选择另一工作标签 Then 只切换工作目标并返回该页状态', () => {
  const h = harness()
  const result = h.controller.selectAgentTab('session-1', 'work-page')
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.activated).toEqual([])
  expect(result).toMatchObject({ tabId: 'work-page', title: 'work-page', activeTabId: 'user-page' })
})

test('Given 显示页与工作页不同 When Agent 导航 Then 结果属于工作页且 UI 投影仍属于显示页', async () => {
  const h = harness()
  const result = await h.controller.navigate('session-1', 'http://127.0.0.1/agent-target')
  expect(result).toMatchObject({ tabId: 'work-page', activeTabId: 'user-page', url: 'http://127.0.0.1/agent-target' })
  expect(h.controller.getState('session-1')).toMatchObject({ activeTabId: 'user-page', url: 'https://example.com/user-page' })
  expect(h.loaded).toEqual(['http://127.0.0.1/agent-target'])
  expect(h.activated).toEqual([])
})

test('Given 用户在另一可见 Pane 输入地址 When 显式指定该 tab Then 返回该页而不改变工作或显示指针', async () => {
  const h = harness()
  const result = await h.controller.navigateDisplay('session-1', 'http://127.0.0.1/pane-target', 'work-page')
  expect(result.url).toBe('http://127.0.0.1/pane-target')
  expect(result.activeTabId).toBe('user-page')
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.activated).toEqual([])
  expect(h.controller.getState('session-1')?.url).toBe('https://example.com/user-page')
})

test('Given 已有后台工作标签 When 用户明确新建页面 Then 仍激活用户新页且保留工作目标', async () => {
  const h = harness()
  await h.controller.createDisplayTab('session-1')
  expect(h.browserSession.activeTabId).toBe('new-page')
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.activated).toEqual(['new-page'])
})

test('Given 用户查看另一页 When Agent 打开本地预览 Then 不激活预览页且结果包含实际 tabId', async () => {
  const h = harness()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-quiet-preview-')))
  const path = join(root, 'index.html')
  writeFileSync(path, '<h1>本地预览</h1>')
  const result = await h.controller.previewOpen('session-1', path, undefined, [root])
  expect(result).toMatchObject({ tabId: 'new-page', activeTabId: 'user-page', localFile: { name: 'index.html', readOnly: true } })
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.activated).toEqual([])
})

test('Given 用户明确打开本地文件 When 预览完成 Then 展示文件且不改工作标签', async () => {
  const h = harness()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-display-preview-')))
  const path = join(root, 'index.html')
  writeFileSync(path, '<h1>本地预览</h1>')
  const result = await h.controller.previewOpenDisplay('session-1', path, [root])
  expect(result).toMatchObject({ activeTabId: 'new-page', localFile: { name: 'index.html', readOnly: true } })
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.browserSession.tabs.get('new-page')?.openedByAgent).toBe(false)
  expect(h.activated).toEqual(['new-page'])
})

test('Given 后台工作页 When 打开新窗口链接 Then 新页留在后台且工作指针和用户显示页都不变', async () => {
  const h = harness()
  await h.popup(h.work)
  expect(h.browserSession.tabs.get('new-page')?.openedByAgent).toBe(true)
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.loaded).toEqual(['http://127.0.0.1/popup'])
  expect(h.activated).toEqual([])
})

test('Given 用户正在查看浏览器 When 当前页打开新窗口链接 Then 展示受管新页但不切换工作指针', async () => {
  const h = harness()
  await h.popup(h.display)
  expect(h.browserSession.tabs.get('new-page')?.openedByAgent).toBe(false)
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.browserSession.activeTabId).toBe('new-page')
  expect(h.activated).toEqual(['new-page'])
})

test('Given Agent 正在操作用户当前页 When 动作派生 popup Then 不把 Agent 手势当成用户展示授权', async () => {
  const h = harness()
  h.markAgentOperating('user-page')
  await h.popup(h.display)
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.activated).toEqual([])
})

test('Given Profer 已失焦 When 原显示页打开新窗口链接 Then 不切换显示目标', async () => {
  const h = harness()
  h.setFocused(false)
  await h.popup(h.display)
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.activated).toEqual([])
})

test('Given 用户正在查看页面 When 请求在系统浏览器打开 Then 只读返回展示页地址且不改动会话', () => {
  const h = harness()
  expect(h.controller.getDisplayUrl('session-1')).toBe('https://example.com/user-page')
  // 只读：不切前台、不激活标签、不改工作指针。
  expect(h.browserSession.activeTabId).toBe('user-page')
  expect(h.browserSession.agentTabId).toBe('work-page')
  expect(h.activated).toEqual([])
})

test('Given 显式指定标签 When 请求外开地址 Then 返回该标签自己的地址', () => {
  const h = harness()
  expect(h.controller.getDisplayUrl('session-1', 'work-page')).toBe('https://example.com/work-page')
})

test('Given 无会话或标签不存在 When 请求外开地址 Then 返回 null 而不创建会话', () => {
  const h = harness()
  expect(h.controller.getDisplayUrl('missing-session')).toBeNull()
  expect(h.controller.getDisplayUrl('session-1', 'missing-tab')).toBeNull()
  expect(h.controller.getState('missing-session')).toBeNull()
})

test('Given 标签还没有真实页面 When 请求外开地址 Then 非 HTTP(S) 地址一律返回 null', () => {
  const h = harness()
  h.display.state.url = 'about:blank'
  expect(h.controller.getDisplayUrl('session-1')).toBeNull()
  h.display.state.url = ''
  expect(h.controller.getDisplayUrl('session-1')).toBeNull()
})
