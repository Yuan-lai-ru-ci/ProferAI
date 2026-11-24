import { expect, spyOn, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserTabSummary, BrowserViewState } from '@profer/shared'
import { Button, type ButtonProps } from '@profer/ui/primitives/button'
import { appModeAtom } from '@/atoms/app-mode'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { browserStateMapAtom } from '@/atoms/browser-atoms'
import { activeTabIdAtom, createBrowserTabId, tabsAtom, type TabItem } from '@/atoms/tab-atoms'
import { tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { selectBackgroundAudioSources } from './tab-context'
import { TabBar } from './TabBar'

function fixture(grouped: boolean, leftAudible?: boolean, rightAudible?: boolean) {
  const store = createStore()
  const page = (tabId: string, audible?: boolean): BrowserTabSummary => ({
    tabId, title: tabId, url: '', loading: false, zoomFactor: 1, localFile: null, openedByAgent: false,
    ...(audible === undefined ? {} : { audible }),
  })
  const pages = [page('左页', leftAudible), page('右页', rightAudible)]
  const state: BrowserViewState = {
    sessionId: 's', activeTabId: '左页', agentTabId: null, tabs: pages, executionSource: 'user',
    url: '', title: '左页', loading: false, zoomFactor: 1, localFile: null, visible: true,
    translated: false, canGoBack: false, canGoForward: false, loadError: null, trace: [], activity: null,
  }
  const tabs = pages.map((page): TabItem => ({
    type: 'browser', id: createBrowserTabId('s', page.tabId), sessionId: 's', browserTabId: page.tabId, title: page.title,
  }))
  store.set(browserStateMapAtom, new Map([['s', state]]))
  store.set(tabsAtom, tabs)
  store.set(activeTabIdAtom, tabs[0]!.id)
  if (grouped) store.set(tabGroupsAtom, [{ leftTabId: tabs[0]!.id, rightTabId: tabs[1]!.id, focusedTabId: tabs[0]!.id }])
  const markup = () => renderToStaticMarkup(<Provider store={store}><TooltipProvider><TabBar /></TooltipProvider></Provider>)
  return { store, state, tabs, markup }
}

function render(grouped: boolean, leftAudible?: boolean, rightAudible?: boolean) {
  return fixture(grouped, leftAudible, rightAudible).markup()
}

test('后台页发声时普通页签显示喇叭及可访问名称，缺少字段的旧页签保持静音', () => {
  const html = render(false, undefined, true)
  expect(html).toContain('aria-label="右页，正在发声"')
  expect(html).not.toContain('左页，正在发声')
  expect(html.match(/lucide-volume2/g)).toHaveLength(1)
})

test('组合页签按成员标注声音；左右都发声时显示两枚喇叭，不依赖当前焦点', () => {
  expect(render(true, false, true)).toContain('aria-label="组合标签页：左页 与 右页（正在发声）（左右双栏）"')
  const both = render(true, true, true)
  expect(both).toContain('左页（正在发声） 与 右页（正在发声）')
  expect(both.match(/lucide-volume2/g)).toHaveLength(2)
  expect(render(true)).not.toContain('正在发声')
})


test('外会话发声提供直达具体页的入口；静音后恢复过滤，不展示同组的静音页或改动手动布局', () => {
  const { store, state, tabs, markup } = fixture(true, undefined, true)
  const owner: TabItem = { id: 's', type: 'agent', sessionId: 's', title: '音乐会话' }
  const other: TabItem = { id: 'chat', type: 'chat', sessionId: 'chat', title: '另一对话' }
  store.set(tabsAtom, [owner, other, ...tabs])
  store.set(activeTabIdAtom, other.id)
  const groups = store.get(tabGroupsAtom)
  const sources = () => selectBackgroundAudioSources(store.get(tabsAtom), [other], store.get(browserStateMapAtom))
  expect(sources()).toEqual([{ id: tabs[1]!.id, label: '右页（音乐会话）' }])
  const html = markup()
  expect(html).toContain('aria-label="前往正在发声的页面：右页（音乐会话）"')
  expect(html).not.toContain('左页')
  expect(html).not.toContain('data-tab-group="true"')
  store.set(browserStateMapAtom, new Map([['s', { ...state, tabs: state.tabs.map(page => ({ ...page, audible: true })) }]]))
  expect(markup()).toContain('aria-label="选择正在发声的页面（2 个）"')
  expect(sources().map(source => source.id)).toEqual(tabs.map(tab => tab.id))
  store.set(browserStateMapAtom, new Map([['s', { ...state, tabs: state.tabs.map(page => ({ ...page, audible: false })) }]]))
  expect(markup()).not.toContain('正在发声')
  expect(store.get(activeTabIdAtom)).toBe(other.id)
  expect(store.get(tabGroupsAtom)).toBe(groups)
})

test('跨上下文残缺组合只展示可见成员本身，不能点击、关闭或解散不可见的另一栏', () => {
  const { store, tabs, markup } = fixture(false, false, false)
  const chat: TabItem = { id: 'chat', type: 'chat', sessionId: 'chat', title: '当前对话' }
  store.set(tabsAtom, [chat, ...tabs])
  store.set(activeTabIdAtom, chat.id)
  store.set(tabGroupsAtom, [{ leftTabId: chat.id, rightTabId: tabs[0]!.id, focusedTabId: tabs[0]!.id }])
  const html = markup()
  expect(html).toContain('data-tab-id="chat"')
  expect(html).not.toContain('data-tab-group="true"')
  expect(html).not.toContain('解散组合')
  expect(html).not.toContain('左页')
})


test('从 Chat 点击声音入口会切换到发声页（而非组合的焦点成员）并同步到 Agent 会话', () => {
  const { store, tabs, markup } = fixture(true, false, true)
  const other: TabItem = { id: 'chat', type: 'chat', sessionId: 'chat', title: '聊天' }
  store.set(tabsAtom, [other, ...tabs])
  store.set(activeTabIdAtom, other.id)
  store.set(appModeAtom, 'chat')
  const requests: unknown[] = []
  const previous = globalThis.window
  // SSR 不生成 DOM 事件；只截取实际 Button 的回调并调用，不替换 TabBar 的激活逻辑。
  const button = Button as unknown as { render: (props: ButtonProps, ref: React.Ref<HTMLButtonElement>) => React.ReactElement }
  const original = button.render
  let click: ButtonProps['onClick']
  const spy = spyOn(button, 'render').mockImplementation((props, ref) => {
    if (props['aria-label']?.startsWith('前往正在发声的页面：')) click = props.onClick
    return original(props, ref)
  })
  try {
    globalThis.window = { electronAPI: {
      selectAgentBrowserTab: async (target: unknown) => { requests.push(target) },
    } } as unknown as typeof window
    markup()
    expect(click).toBeFunction()
    click!({} as React.MouseEvent<HTMLButtonElement>)
    expect(requests).toEqual([{ sessionId: 's', tabId: '右页' }])
    expect(store.get(activeTabIdAtom)).toBe(tabs[1]!.id)
    expect(store.get(currentAgentSessionIdAtom)).toBe('s')
    expect(store.get(appModeAtom)).toBe('agent')
  } finally {
    spy.mockRestore()
    globalThis.window = previous
  }
})
