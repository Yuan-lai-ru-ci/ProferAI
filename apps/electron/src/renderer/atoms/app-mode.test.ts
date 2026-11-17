/**
 * app-mode 单元测试
 *
 * 固化「界面显示的模式必须与活动标签页一致」这条契约。
 *
 * 回归背景（用户实测截图）：模式切换器高亮 Agent，激活的标签页却是 Chat 会话。
 * 成因是旧的 appModeAtom 是独立可变状态，靠十几个调用点各自同步；`⌘⇧M`
 * 只改模式不动标签页，于是立刻分叉。现在模式由活动标签页派生。
 */

import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { appModeAtom, appModeForTab, appModeIntentAtom } from './app-mode'
import { activeTabIdAtom, SCRATCH_PAD_ID, TUTORIAL_TAB_ID, tabsAtom, type TabItem } from './tab-atoms'

const chatTab: TabItem = { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '对话' }
const agentTab: TabItem = { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '会话' }
const previewTab: TabItem = { id: 'preview-1', type: 'preview', sessionId: 'agent-1', title: '预览', filePath: '/tmp/a.ts' }
const browserTab: TabItem = { id: 'browser-1', type: 'browser', sessionId: 'agent-1', title: '浏览器', browserTabId: 'b1' }
const tutorialTab: TabItem = { id: TUTORIAL_TAB_ID, type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: '教程' }
const scratchTab: TabItem = { id: SCRATCH_PAD_ID, type: 'scratch', sessionId: SCRATCH_PAD_ID, title: '草稿本' }

describe('appModeForTab', () => {
  test('Given Chat 标签 When 推导 Then 得到 chat', () => {
    expect(appModeForTab(chatTab)).toBe('chat')
  })

  test('Given Agent / 预览 / 浏览器 标签 When 推导 Then 都归属 agent', () => {
    expect(appModeForTab(agentTab)).toBe('agent')
    expect(appModeForTab(previewTab)).toBe('agent')
    expect(appModeForTab(browserTab)).toBe('agent')
  })

  test('Given 草稿本 标签 When 推导 Then 得到 scratch', () => {
    expect(appModeForTab(scratchTab)).toBe('scratch')
  })

  test('Given 教程 标签 When 推导 Then 返回 null（不代表任何模式）', () => {
    expect(appModeForTab(tutorialTab)).toBeNull()
  })

  test('Given 没有标签 When 推导 Then 返回 null', () => {
    expect(appModeForTab(null)).toBeNull()
  })
})

describe('appModeAtom 与活动标签页一致', () => {
  test('Given 意图是 agent 但激活 Chat 标签 When 读取 Then 显示 chat（不再分叉）', () => {
    const store = createStore()
    store.set(appModeIntentAtom, 'agent')
    store.set(tabsAtom, [chatTab, agentTab])
    store.set(activeTabIdAtom, chatTab.id)

    expect(store.get(appModeAtom)).toBe('chat')
  })

  test('Given 意图是 chat 但激活 Agent 标签 When 读取 Then 显示 agent', () => {
    const store = createStore()
    store.set(appModeIntentAtom, 'chat')
    store.set(tabsAtom, [chatTab, agentTab])
    store.set(activeTabIdAtom, agentTab.id)

    expect(store.get(appModeAtom)).toBe('agent')
  })

  test('Given 没有可表达模式的标签（教程）When 读取 Then 回落到意图', () => {
    const store = createStore()
    store.set(appModeIntentAtom, 'chat')
    store.set(tabsAtom, [tutorialTab])
    store.set(activeTabIdAtom, tutorialTab.id)

    expect(store.get(appModeAtom)).toBe('chat')
  })

  test('Given 没有标签页 When 读取 Then 回落到意图（启动瞬间不闪烁）', () => {
    const store = createStore()
    store.set(appModeIntentAtom, 'agent')

    expect(store.get(appModeAtom)).toBe('agent')
  })

  test('Given 写入 appModeAtom When 读取 Then 同步写入意图（兼容既有 setAppMode 调用）', () => {
    const store = createStore()
    store.set(appModeAtom, 'chat')

    expect(store.get(appModeIntentAtom)).toBe('chat')
  })
})
