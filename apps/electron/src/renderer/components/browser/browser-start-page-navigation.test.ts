import { expect, test } from 'bun:test'
import type { BrowserViewState } from '@profer/shared'
import { shouldNavigateDefaultHome } from './browser-start-page-navigation'

function browserState(overrides: Partial<BrowserViewState> = {}): BrowserViewState {
  return {
    sessionId: 'session-1',
    executionSource: 'user',
    activeTabId: 'tab-1',
    agentTabId: null,
    tabs: [],
    url: '',
    title: '新建标签页',
    loading: false,
    visible: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    translated: false,
    trace: [],
    activity: null,
    ...overrides,
  }
}

test('默认首页不会为尚未打开浏览器的新 Agent 会话创建浏览器', () => {
  expect(shouldNavigateDefaultHome(null, 'https://www.example.com', null)).toBeFalse()
})

test('默认首页只导航一次已存在的空标签', () => {
  const state = browserState()
  expect(shouldNavigateDefaultHome(state, 'https://www.example.com', null)).toBeTrue()
  expect(shouldNavigateDefaultHome(state, 'https://www.example.com', state.activeTabId)).toBeFalse()
})

test('已有网页内容的标签不会被默认首页覆盖', () => {
  expect(shouldNavigateDefaultHome(browserState({ url: 'https://www.bilibili.com/' }), 'https://www.example.com', null)).toBeFalse()
})
