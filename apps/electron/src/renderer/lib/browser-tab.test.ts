import { expect, test } from 'bun:test'
import type { BrowserViewState } from '@profer/shared'
import type { TabItem } from '@/atoms/tab-atoms'
import { activeBrowserTopTabId, planBrowserTabReconcile } from './browser-tab'

const agentTab = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })

function state(partial: Partial<BrowserViewState> & Pick<BrowserViewState, 'sessionId' | 'activeTabId' | 'tabs'>): BrowserViewState {
  return {
    executionSource: null,
    url: '',
    title: '',
    localFile: null,
    loading: false,
    visible: true,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    trace: [],
    activity: null,
    translated: false,
    loadError: null,
    agentTabId: null,
    ...partial,
  } as BrowserViewState
}

const page = (tabId: string, title: string) => ({
  tabId,
  url: `https://example.com/${tabId}`,
  title,
  localFile: null,
  loading: false,
  zoomFactor: 1,
  openedByAgent: false,
})

test('首次推送：每个浏览器页生成一个顶栏 Tab，挂在会话 Tab 之后', () => {
  const tabs = [agentTab('s1')]
  const next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  }), false)
  const browserTabs = next.filter((t) => t.type === 'browser')
  expect(browserTabs.map((t) => t.browserTabId)).toEqual(['t1', 't2'])
  expect(browserTabs[0]?.sessionId).toBe('s1')
  expect(browserTabs[0]?.title).toBe('页面一')
})

test('页面被关闭时移除对应顶栏 Tab，保留其他页', () => {
  const tabs = [agentTab('s1')]
  let next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  }), false)
  next = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }), false)
  expect(next.filter((t) => t.type === 'browser').map((t) => t.browserTabId)).toEqual(['t1'])
})

test('会话销毁（tabs 为空）时移除全部浏览器 Tab', () => {
  const tabs = [agentTab('s1')]
  let next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }), false)
  next = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: '',
    tabs: [],
  }), false)
  expect(next.some((t) => t.type === 'browser' && t.sessionId === 's1')).toBe(false)
  expect(next.some((t) => t.id === 's1')).toBe(true)
})

test('dismissed 时不新增 Tab，但仍同步标题与移除已关闭页', () => {
  const tabs = [agentTab('s1')]
  let next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '旧标题')],
  }), false)
  // dismissed 状态下：标题同步 + 关闭页移除生效，新页不建
  next = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '新标题'), page('t2', '页面二')],
  }), true)
  const browserTabs = next.filter((t) => t.type === 'browser')
  expect(browserTabs.map((t) => t.browserTabId)).toEqual(['t1'])
  expect(browserTabs[0]?.title).toBe('新标题')
})

test('无变化时返回引用相同的数组', () => {
  const tabs = [agentTab('s1')]
  const next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }), false)
  const again = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }), false)
  expect(again).toBe(next)
})

test('activeBrowserTopTabId 指向激活页', () => {
  expect(activeBrowserTopTabId('s1', state({
    sessionId: 's1',
    activeTabId: 't2',
    tabs: [page('t1', '一'), page('t2', '二')],
  }))).toBe('__browser__:s1:t2')
})
