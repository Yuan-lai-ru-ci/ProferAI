import { afterEach, expect, test } from 'bun:test'
import { getDefaultStore } from 'jotai'
import type { BrowserViewState } from '@profer/shared'
import { activeTabIdAtom, reorderTabs, tabsAtom, type TabItem } from '@/atoms/tab-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { activeBrowserTopTabId, openBrowserTabFromPush, planBrowserTabReconcile } from './browser-tab'

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

test('已有浏览器页重排后再次同步状态不会重新建立已解散的组合', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  store.set(tabGroupsAtom, [])
  const browserState = state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  })

  openBrowserTabFromPush(browserState)
  expect(store.get(tabGroupsAtom)).toHaveLength(1)

  store.set(tabGroupsAtom, [])
  const tabs = store.get(tabsAtom)
  const reordered = reorderTabs(tabs, tabs.findIndex((tab) => tab.id === 's1'), tabs.findIndex((tab) => tab.browserTabId === 't1'))
  store.set(tabsAtom, reordered)
  openBrowserTabFromPush(browserState)

  expect(store.get(tabGroupsAtom)).toEqual([])
  expect(store.get(tabsAtom)).toBe(reordered)
  expect(reordered.filter((tab) => tab.sessionId === 's1').map((tab) => tab.id)).toEqual(['__browser__:s1:t1', 's1'])
  expect(store.get(activeTabIdAtom)).toBe('s1')

  // 后续页面标题与新页面继续同步，不能撤销用户的解散选择。
  openBrowserTabFromPush(state({
    sessionId: 's1',
    activeTabId: 't2',
    tabs: [page('t1', '更新标题'), page('t2', '页面二')],
  }))
  expect(store.get(tabGroupsAtom)).toEqual([])
  expect(store.get(tabsAtom).find((tab) => tab.browserTabId === 't1')?.title).toBe('更新标题')
  expect(store.get(tabsAtom).some((tab) => tab.browserTabId === 't2')).toBe(true)
})

test('切回会话恢复浏览器标签不自动建组，后续同页推送也保留独立布局', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const browserState = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '页面一')] })

  openBrowserTabFromPush(browserState, { autoGroup: false })
  expect(store.get(tabsAtom).filter((tab) => tab.sessionId === 's1').map((tab) => tab.id)).toEqual(['s1', '__browser__:s1:t1'])
  expect(store.get(tabGroupsAtom)).toEqual([])
  openBrowserTabFromPush(browserState)
  expect(store.get(tabGroupsAtom)).toEqual([])
})

afterEach(() => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'scratch')
  store.set(currentAgentSessionIdAtom, null)
  store.set(tabsAtom, [])
  store.set(activeTabIdAtom, null)
  store.set(tabGroupsAtom, [])
})

test('activeBrowserTopTabId 指向激活页', () => {
  expect(activeBrowserTopTabId('s1', state({
    sessionId: 's1',
    activeTabId: 't2',
    tabs: [page('t1', '一'), page('t2', '二')],
  }))).toBe('__browser__:s1:t2')
})
