import { afterEach, expect, test } from 'bun:test'
import { getDefaultStore } from 'jotai'
import type { BrowserViewState } from '@profer/shared'
import { activeTabIdAtom, reorderTabs, tabsAtom, type TabItem } from '@/atoms/tab-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { captureBrowserOpenIntent, openBrowserTabFromPush, openBrowserTabManually, planBrowserTabReconcile } from './browser-tab'

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

// 模拟主进程先发状态推送，再返回用户打开操作的 IPC 结果。
function openFromUser(snapshot: BrowserViewState): void {
  const intent = captureBrowserOpenIntent(snapshot.sessionId)
  openBrowserTabFromPush(snapshot)
  openBrowserTabManually(snapshot.sessionId, snapshot, undefined, intent)
}

test('首次推送：每个浏览器页生成一个顶栏 Tab，挂在会话 Tab 之后', () => {
  const tabs = [agentTab('s1')]
  const next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  }))
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
  }))
  next = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }))
  expect(next.filter((t) => t.type === 'browser').map((t) => t.browserTabId)).toEqual(['t1'])
})

test('会话销毁（tabs 为空）时移除全部浏览器 Tab', () => {
  const tabs = [agentTab('s1')]
  let next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }))
  next = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: '',
    tabs: [],
  }))
  expect(next.some((t) => t.type === 'browser' && t.sessionId === 's1')).toBe(false)
  expect(next.some((t) => t.id === 's1')).toBe(true)
})

test('同一状态推送新增真实网页，同时同步标题并移除已关闭网页', () => {
  const tabs = [agentTab('s1')]
  let next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '旧标题'), page('closed', '已关闭')],
  }))
  next = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '新标题'), page('t2', '页面二')],
  }))
  const browserTabs = next.filter((t) => t.type === 'browser')
  expect(browserTabs.map((t) => t.browserTabId)).toEqual(['t1', 't2'])
  expect(browserTabs[0]?.title).toBe('新标题')
})

test('无变化时返回引用相同的数组', () => {
  const tabs = [agentTab('s1')]
  const next = planBrowserTabReconcile(tabs, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }))
  const again = planBrowserTabReconcile(next, 's1', state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一')],
  }))
  expect(again).toBe(next)
})

test('Given Agent 首次推送 When 用户未打开浏览器 Then 每页有顶栏页签但不激活、不分屏', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  openBrowserTabFromPush(state({ sessionId: 's1', activeTabId: 't1', agentTabId: 't1', tabs: [page('t1', '工作页')] }))
  expect(store.get(tabsAtom).filter(tab => tab.type === 'browser').map(tab => tab.browserTabId)).toEqual(['t1'])
  expect(store.get(activeTabIdAtom)).toBe('s1')
  expect(store.get(tabGroupsAtom)).toEqual([])
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

  openFromUser(browserState)
  store.set(activeTabIdAtom, 's1')
  store.set(tabGroupsAtom, [{ leftTabId: 's1', rightTabId: '__browser__:s1:t1', focusedTabId: 's1' }])

  store.set(tabGroupsAtom, [])
  const tabs = store.get(tabsAtom)
  const reordered = reorderTabs(tabs, tabs.findIndex((tab) => tab.id === 's1'), tabs.findIndex((tab) => tab.browserTabId === 't1'))
  store.set(tabsAtom, reordered)
  openBrowserTabFromPush(browserState)

  expect(store.get(tabGroupsAtom)).toEqual([])
  expect(store.get(tabsAtom)).toBe(reordered)
  expect(reordered.filter((tab) => tab.sessionId === 's1').map((tab) => tab.id)).toEqual(['__browser__:s1:t1', 's1'])
  expect(store.get(activeTabIdAtom)).toBe('s1')

  // 后续登记新页，不挪动已有页签或重新建组。
  openBrowserTabFromPush(state({
    sessionId: 's1',
    activeTabId: 't1',
    agentTabId: 't2',
    tabs: [page('t1', '更新标题'), page('t2', '页面二')],
  }))
  expect(store.get(tabGroupsAtom)).toEqual([])
  expect(store.get(tabsAtom).find((tab) => tab.browserTabId === 't1')?.title).toBe('更新标题')
  expect(store.get(tabsAtom).filter(tab => tab.sessionId === 's1').map(tab => tab.id)).toEqual(['__browser__:s1:t1', 's1', '__browser__:s1:t2'])
})

test('切回会话恢复真实页签，重复推送不重复创建或改变布局', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const browserState = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '页面一')] })

  openBrowserTabFromPush(browserState)
  const restored = store.get(tabsAtom)
  expect(restored.filter((tab) => tab.sessionId === 's1').map((tab) => tab.id)).toEqual(['s1', '__browser__:s1:t1'])
  expect(store.get(tabGroupsAtom)).toEqual([])
  openBrowserTabFromPush(browserState)
  expect(store.get(tabsAtom)).toBe(restored)
  expect(store.get(tabGroupsAtom)).toEqual([])
})

test('页面内新开并激活的页接管原分屏栏，不抢正在看的会话', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  store.set(tabGroupsAtom, [])

  const first = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '页面一')] })
  openFromUser(first)
  store.set(activeTabIdAtom, 's1')
  store.set(tabGroupsAtom, [{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t1',
    focusedTabId: 's1',
  }])

  const next = state({
    sessionId: 's1',
    activeTabId: 't2',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  })
  openBrowserTabFromPush(next, first)

  expect(store.get(tabGroupsAtom)).toEqual([{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t2',
    focusedTabId: 's1',
  }])
  expect(store.get(activeTabIdAtom)).toBe('s1')
})

test('页面内新页接管时，如果原浏览器页是焦点成员，焦点跟到新页', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, '__browser__:s1:t1')
  store.set(tabGroupsAtom, [{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t1',
    focusedTabId: '__browser__:s1:t1',
  }])

  const first = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '页面一')] })
  openFromUser(first)
  // 用户显式打开补齐 t1 顶栏 Tab；组合与激活状态保持不变
  store.set(tabGroupsAtom, [{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t1',
    focusedTabId: '__browser__:s1:t1',
  }])
  store.set(activeTabIdAtom, '__browser__:s1:t1')

  const next = state({
    sessionId: 's1',
    activeTabId: 't2',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  })
  openBrowserTabFromPush(next, first)

  expect(store.get(tabGroupsAtom)).toEqual([{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t2',
    focusedTabId: '__browser__:s1:t2',
  }])
  expect(store.get(activeTabIdAtom)).toBe('__browser__:s1:t2')
})

test('切到已有页不接管分屏栏，保留用户主动选择的页', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  store.set(tabGroupsAtom, [{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t1',
    focusedTabId: 's1',
  }])

  const first = state({
    sessionId: 's1',
    activeTabId: 't1',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  })
  openFromUser(first)
  store.set(activeTabIdAtom, 's1')
  const next = state({
    sessionId: 's1',
    activeTabId: 't2',
    tabs: [page('t1', '页面一'), page('t2', '页面二')],
  })
  openBrowserTabFromPush(next, first)

  expect(store.get(tabGroupsAtom)).toEqual([{
    leftTabId: 's1',
    rightTabId: '__browser__:s1:t1',
    focusedTabId: 's1',
  }])
})

test('Given 用户从可见分屏选择后台页 When 异步结果返回 Then 替换原栏并保留对话焦点', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const first = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '用户页'), page('t2', '后台页')] })
  openFromUser(first)
  store.set(activeTabIdAtom, 's1')
  store.set(tabGroupsAtom, [{ leftTabId: 's1', rightTabId: '__browser__:s1:t1', focusedTabId: 's1' }])
  const intent = captureBrowserOpenIntent('s1', 't1')
  openBrowserTabManually('s1', { ...first, activeTabId: 't2' }, 't2', intent)
  expect(store.get(activeTabIdAtom)).toBe('s1')
  expect(store.get(tabGroupsAtom)).toEqual([{ leftTabId: 's1', rightTabId: '__browser__:s1:t2', focusedTabId: 's1' }])
})

test('Given 用户发起打开后切到另一页 When 旧结果返回 Then 不重新激活或创建旧会话页签', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1'), { id: 'preview', type: 'preview', sessionId: 's1', title: '文件' }])
  store.set(activeTabIdAtom, 's1')
  const intent = captureBrowserOpenIntent('s1')
  store.set(activeTabIdAtom, 'preview')
  const before = store.get(tabsAtom)
  openBrowserTabManually('s1', state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '迟到页面')] }), undefined, intent)
  expect(store.get(activeTabIdAtom)).toBe('preview')
  expect(store.get(tabsAtom)).toBe(before)
})

test('Given 主进程推送先接管了新建页 When 手动打开结果稍后返回 Then 不因旧面板卸载丢失正常操作', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const first = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '原页')] })
  openFromUser(first)
  const intent = captureBrowserOpenIntent('s1', 't1')
  const next = state({ sessionId: 's1', activeTabId: 't2', tabs: [page('t1', '原页'), page('t2', '新页')] })
  openBrowserTabFromPush(next, first)
  expect(store.get(activeTabIdAtom)).toBe('__browser__:s1:t2')
  openBrowserTabManually('s1', next, 't2', intent)
  expect(store.get(activeTabIdAtom)).toBe('__browser__:s1:t2')
})

test('Given 用户已切换到其他会话或模式 When 旧打开结果返回 Then 不抢回浏览器', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1'), agentTab('s2')])
  store.set(activeTabIdAtom, 's1')
  const intent = captureBrowserOpenIntent('s1')
  store.set(currentAgentSessionIdAtom, 's2')
  store.set(activeTabIdAtom, 's2')
  openBrowserTabManually('s1', state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '旧页')] }), 't1', intent)
  expect(store.get(activeTabIdAtom)).toBe('s2')
  expect(store.get(tabsAtom).some(tab => tab.type === 'browser')).toBe(false)
})

test('Given 用户从浏览器切到规划中心 When 旧手动结果不抢焦点，实时推送仍登记实际网页', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const intent = captureBrowserOpenIntent('s1')
  store.set(activeViewAtom, 'planning')
  const before = store.get(tabsAtom)
  const next = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '后台页')] })
  openBrowserTabManually('s1', next, 't1', intent)
  expect(store.get(tabsAtom)).toBe(before)
  openBrowserTabFromPush(next)
  expect(store.get(tabsAtom).some(tab => tab.browserTabId === 't1')).toBe(true)
  expect(store.get(activeViewAtom)).toBe('planning')
  expect(store.get(activeTabIdAtom)).toBe('s1')
})

test('用户手动分屏后 Agent 新建或切换工作页保留原组合；解散后导航或刷新也不重建', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const first = state({ sessionId: 's1', activeTabId: 't1', agentTabId: 't1', tabs: [page('t1', '一')] })
  openBrowserTabFromPush(first)
  const groups = [{ leftTabId: 's1', rightTabId: '__browser__:s1:t1', focusedTabId: 's1' }]
  store.set(tabGroupsAtom, groups)
  const next = { ...first, agentTabId: 't2', tabs: [...first.tabs, { ...page('t2', '二'), openedByAgent: true }] }
  openBrowserTabFromPush(next, first)
  expect(store.get(tabGroupsAtom)).toBe(groups)
  expect(store.get(tabsAtom).filter(tab => tab.type === 'browser').map(tab => tab.browserTabId)).toEqual(['t1', 't2'])
  store.set(tabGroupsAtom, [])
  openBrowserTabFromPush({ ...next, tabs: [first.tabs[0]!, { ...next.tabs[1]!, title: '刷新后的网页' }] }, next)
  expect(store.get(tabGroupsAtom)).toEqual([])
  expect(store.get(activeTabIdAtom)).toBe('s1')
})

test('非当前会话新增工作页也登记到它自己的顶栏，不切走用户正在看的会话', () => {
  const store = getDefaultStore()
  store.set(tabsAtom, [agentTab('s1'), agentTab('s2')])
  store.set(activeTabIdAtom, 's1')
  store.set(currentAgentSessionIdAtom, 's1')
  openBrowserTabFromPush(state({ sessionId: 's2', activeTabId: 't1', agentTabId: 't1', tabs: [page('t1', '二')] }))
  expect(store.get(tabsAtom).find(tab => tab.browserTabId === 't1')?.sessionId).toBe('s2')
  expect(store.get(currentAgentSessionIdAtom)).toBe('s1')
  expect(store.get(activeTabIdAtom)).toBe('s1')
  expect(store.get(tabGroupsAtom)).toEqual([])
})

afterEach(() => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'scratch')
  store.set(activeViewAtom, 'conversations')
  store.set(currentAgentSessionIdAtom, null)
  store.set(tabsAtom, [])
  store.set(activeTabIdAtom, null)
  store.set(tabGroupsAtom, [])
})

test('正在看的页被关闭时回到会话，不留下空白内容区', () => {
  const store = getDefaultStore()
  store.set(tabsAtom, [agentTab('s1')])
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  openFromUser(state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '一')] }))
  expect(store.get(activeTabIdAtom)).toBe('__browser__:s1:t1')
  openBrowserTabFromPush(state({ sessionId: 's1', activeTabId: '', tabs: [] }))
  expect(store.get(activeTabIdAtom)).toBe('s1')
  expect(store.get(tabsAtom).some(tab => tab.type === 'browser')).toBe(false)
})

test('用户打开网页的回包晚于关页推送时，不重建页签或抢焦点', () => {
  const store = getDefaultStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, 's1')
  store.set(tabsAtom, [agentTab('s1')])
  store.set(activeTabIdAtom, 's1')
  const intent = captureBrowserOpenIntent('s1')
  const first = state({ sessionId: 's1', activeTabId: 't1', tabs: [page('t1', '网页')] })
  openBrowserTabFromPush(first)
  openBrowserTabFromPush({ ...first, activeTabId: '', tabs: [] }, first)
  openBrowserTabManually('s1', first, 't1', intent)
  expect(store.get(tabsAtom).some(tab => tab.type === 'browser')).toBe(false)
  expect(store.get(activeTabIdAtom)).toBe('s1')
})
