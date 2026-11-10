import { describe, expect, test } from 'bun:test'
import type { BrowserTabSummary, BrowserTraceItem, BrowserViewState } from '@profer/shared'
import { shouldAutoOpenBrowserFromPush } from './browser-auto-open'

type BrowserPushSnapshot = Pick<BrowserViewState, 'agentTabId' | 'tabs' | 'activity'>

function tab(tabId: string): BrowserTabSummary {
  return { tabId, url: `https://example.com/${tabId}`, title: tabId, localFile: null, loading: false, zoomFactor: 1, openedByAgent: true }
}

function trace(action: BrowserTraceItem['action']): BrowserTraceItem {
  return {
    id: '1',
    action,
    summary: action,
    at: 1,
    success: true,
    status: 'verified',
    tabId: 'tab-1',
    domain: 'example.com',
    executionSource: 'user',
  }
}

function snapshot(overrides: Partial<BrowserPushSnapshot>): BrowserPushSnapshot {
  return {
    agentTabId: 'tab-1',
    tabs: [tab('tab-1')],
    activity: trace('navigate'),
    ...overrides,
  }
}

describe('浏览器状态推送自动打开门禁', () => {
  test('Given Agent 导航或新建标签 When 默认收到状态推送 Then 保持后台静默', () => {
    expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: trace('navigate') }))).toBe(false)
    expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: trace('tab') }))).toBe(false)
  })

  test('Given 用户明确启用跟随 When Agent 导航或新建标签 Then 允许展示', () => {
    expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: trace('navigate') }), true)).toBe(true)
    expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: trace('tab') }), true)).toBe(true)
    expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: trace('observe') }), true)).toBe(false)
    expect(shouldAutoOpenBrowserFromPush(snapshot({ agentTabId: null }), true)).toBe(false)
  })

  test('Given 只读动作 When 收到状态推送 Then 不打开浏览器面板', () => {
    for (const action of ['observe', 'wait', 'screenshot', 'dom', 'script', 'click', 'fill', 'press'] as const) {
      expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: trace(action) }))).toBe(false)
    }
  })

  test('Given 没有 Agent 工作标签 When 收到状态推送 Then 不打开浏览器面板', () => {
    expect(shouldAutoOpenBrowserFromPush(snapshot({ agentTabId: null }))).toBe(false)
    // agentTabId 指向已不存在的标签：晚到的状态不能打开空白面板
    expect(shouldAutoOpenBrowserFromPush(snapshot({ agentTabId: 'tab-missing' }))).toBe(false)
  })

  test('Given 没有任何操作记录 When 收到状态推送 Then 不打开浏览器面板', () => {
    expect(shouldAutoOpenBrowserFromPush(snapshot({ activity: null }))).toBe(false)
  })
})
