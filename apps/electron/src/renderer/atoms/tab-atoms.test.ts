import { expect, test } from 'bun:test'
import { closeTab, createPluginTabId, getPersistableTabState, openPluginTab, openTab, selectSameModeCloseFallback, tabContextSessionId, type TabItem } from './tab-atoms'

const tab = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })

test('关闭当前普通标签时回退到最近访问标签而非右侧标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b'), tab('c')], 'c', 'c', ['c', 'b', 'a'])
  expect(result.activeTabId).toBe('b')
  expect(result.mru).toEqual(['b', 'a'])
})

test('关闭非当前标签不改变活动标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b')], 'a', 'b', ['a', 'b'])
  expect(result.activeTabId).toBe('a')
  expect(result.mru).toEqual(['a'])
})

test('打开插件页时生成稳定 Tab，且插件 Tab 不写入会话持久化', () => {
  const result = openPluginTab([], { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo' })
  expect(result.activeTabId).toBe(createPluginTabId('com.example.demo', 'dashboard'))
  expect(result.tabs.map((item) => item.type)).toEqual(['scratch', 'plugin'])
  expect(getPersistableTabState(result.tabs, result.activeTabId)).toEqual({ tabs: [], activeTabId: null })
})

test('重复打开同一个插件页只聚焦已有 Tab', () => {
  const first = openPluginTab([], { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo' })
  const second = openPluginTab(first.tabs, { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo' })
  expect(second.tabs).toHaveLength(2)
  expect(second.activeTabId).toBe(first.activeTabId)
})

test('会话插件页绑定宿主会话并插入工作 Tab 簇', () => {
  const owner = tab('session-a')
  const result = openPluginTab([owner], { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo', sessionId: 'session-a', scope: 'session' })
  const plugin = result.tabs.find((item) => item.type === 'plugin')
  expect(plugin).toMatchObject({ sessionId: 'session-a', pluginScope: 'session' })
  expect(result.tabs.map((item) => item.id)).toEqual(['__scratch-pad__', 'session-a', plugin!.id])
})

test('关闭会话时连带移除绑定的插件 Tab', () => {
  const owner = tab('session-a')
  const opened = openPluginTab([owner], { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo', sessionId: 'session-a', scope: 'session' })
  const result = closeTab(opened.tabs, opened.activeTabId, 'session-a', ['session-a'])
  expect(result.tabs.some((item) => item.type === 'plugin' && item.sessionId === 'session-a')).toBe(false)
})


test('同一会话可同时打开多个文件预览 Tab，重复打开同一文件只聚焦', () => {
  const agent = tab('s1')
  let state = openTab([agent], { type: 'preview', sessionId: 's1', title: '预览：a.ts', filePath: '/w/a.ts' })
  state = openTab(state.tabs, { type: 'preview', sessionId: 's1', title: '预览：b.ts', filePath: '/w/b.ts' })
  const previewTabs = state.tabs.filter((t) => t.type === 'preview')
  expect(previewTabs).toHaveLength(2)
  // 新预览 Tab 插在 owner 会话 Tab 之后
  expect(state.tabs[1]?.id).toBe('s1')
  // 重复打开同一文件：数量不变，聚焦既有 Tab
  const again = openTab(state.tabs, { type: 'preview', sessionId: 's1', title: '预览：a.ts', filePath: '/w/a.ts' })
  expect(again.tabs.filter((t) => t.type === 'preview')).toHaveLength(2)
  expect(again.activeTabId).toBe(state.tabs.find((t) => t.filePath === '/w/a.ts')!.id)
})

test('浏览器 Tab 每会话单例，重复打开只聚焦', () => {
  const agent = tab('s1')
  const first = openTab([agent], { type: 'browser', sessionId: 's1', title: '浏览器' })
  const second = openTab(first.tabs, { type: 'browser', sessionId: 's1', title: '浏览器' })
  expect(second.tabs.filter((t) => t.type === 'browser')).toHaveLength(1)
  expect(second.activeTabId).toBe(first.activeTabId)
})

test('关闭会话 Tab 时连带关闭其全部工作 Tab（预览×N + 浏览器）', () => {
  const agent = tab('s1')
  let state = openTab([agent], { type: 'preview', sessionId: 's1', title: '预览：a.ts', filePath: '/w/a.ts' })
  state = openTab(state.tabs, { type: 'preview', sessionId: 's1', title: '预览：b.ts', filePath: '/w/b.ts' })
  state = openTab(state.tabs, { type: 'browser', sessionId: 's1', title: '浏览器' })
  // 其它会话的工作 Tab 不受影响
  state = openTab(state.tabs, { type: 'agent', sessionId: 's2', title: 's2' })
  state = openTab(state.tabs, { type: 'preview', sessionId: 's2', title: '预览：c.ts', filePath: '/w/c.ts' })
  const result = closeTab(state.tabs, 's1', 's1', ['s2', 's1'])
  expect(result.tabs.some((t) => t.sessionId === 's1')).toBe(false)
  expect(result.tabs.some((t) => t.sessionId === 's2' && t.type === 'preview')).toBe(true)
})

test('工作 Tab 不参与持久化，激活工作 Tab 时持久化回退到 owner 会话', () => {
  const agent = tab('s1')
  const state = openTab([agent], { type: 'preview', sessionId: 's1', title: '预览：a.ts', filePath: '/w/a.ts' })
  const persisted = getPersistableTabState(state.tabs, state.activeTabId)
  expect(persisted.tabs.map((t) => t.id)).toEqual(['s1'])
  expect(persisted.activeTabId).toBe('s1')
})

test('打开会话不再丢弃其工作 Tab', () => {
  const agent = tab('s1')
  let state = openTab([agent], { type: 'preview', sessionId: 's1', title: '预览：a.ts', filePath: '/w/a.ts' })
  state = openTab(state.tabs, { type: 'agent', sessionId: 's1', title: 's1' })
  expect(state.activeTabId).toBe('s1')
  expect(state.tabs.some((t) => t.type === 'preview' && t.sessionId === 's1')).toBe(true)
})

// ===== 子会话 Tab（parentSessionId 血缘）=====

test('打开子会话 Tab 携带 parentSessionId，且参与持久化', () => {
  const parent = tab('parent-1')
  const state = openTab([parent], { type: 'agent', sessionId: 'child-1', title: '子会话', parentSessionId: 'parent-1' })
  expect(state.tabs.find((t) => t.id === 'child-1')?.parentSessionId).toBe('parent-1')
  const persisted = getPersistableTabState(state.tabs, state.activeTabId)
  expect(persisted.tabs.map((t) => t.id)).toContain('child-1')
  expect(persisted.tabs.find((t) => t.id === 'child-1')?.parentSessionId).toBe('parent-1')
})

test('已存在的 Tab 补上血缘时不丢原数据', () => {
  const existing = tab('child-1')
  const state = openTab([tab('parent-1'), existing], { type: 'agent', sessionId: 'child-1', title: '子会话', parentSessionId: 'parent-1' })
  expect(state.tabs.find((t) => t.id === 'child-1')).toEqual({ ...existing, parentSessionId: 'parent-1' })
})

test('tabContextSessionId 沿血缘走到根会话', () => {
  const tabs: TabItem[] = [
    tab('root'),
    { ...tab('mid'), parentSessionId: 'root' },
    { ...tab('leaf'), parentSessionId: 'mid' },
  ]
  expect(tabContextSessionId(tabs, tabs[2]!)).toBe('root')
  expect(tabContextSessionId(tabs, tabs[1]!)).toBe('root')
  expect(tabContextSessionId(tabs, tabs[0]!)).toBe('root')
})

test('tabContextSessionId 在父 Tab 缺失或血缘成环时回退自身', () => {
  const orphan: TabItem = { ...tab('orphan'), parentSessionId: 'missing' }
  expect(tabContextSessionId([orphan], orphan)).toBe('orphan')
  const a: TabItem = { ...tab('a'), parentSessionId: 'b' }
  const b: TabItem = { ...tab('b'), parentSessionId: 'a' }
  expect(tabContextSessionId([a, b], a)).toBe('b')
  expect(tabContextSessionId([a, b], b)).toBe('a')
})

test('关闭回退：同类会话还在时优先 MRU 回退到同类，不跨模式', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const agentA = tab('agent-a')
  const chatC: TabItem = { ...tab('chat-c'), type: 'chat' }
  const remaining = [scratch, agentA, chatC]
  // 关闭 agent-b，引擎结果落到 chat-c，但还有 agent-a → 回退到 agent-a
  const closing = tab('agent-b')
  expect(selectSameModeCloseFallback(remaining, closing, true, ['chat-c', 'agent-a'], 'chat-c')).toBe('agent-a')
})

test('关闭回退：关闭最后一个 agent 时回 Scratch Pad，不跳 chat', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const chatC: TabItem = { ...tab('chat-c'), type: 'chat' }
  const remaining = [scratch, chatC]
  const closing = tab('agent-a')
  expect(selectSameModeCloseFallback(remaining, closing, true, ['chat-c', 'agent-a'], 'chat-c')).toBe('__scratch-pad__')
})

test('关闭回退：关闭最后一个 chat 时回 Scratch Pad，不跳 agent', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const agentA = tab('agent-a')
  const remaining = [scratch, agentA]
  const closing: TabItem = { ...tab('chat-c'), type: 'chat' }
  expect(selectSameModeCloseFallback(remaining, closing, true, ['agent-a', 'chat-c'], 'agent-a')).toBe('__scratch-pad__')
})

test('关闭回退：引擎结果已是同类/关闭工作 Tab/非激活关闭时不覆盖', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const agentA = tab('agent-a')
  const agentB = tab('agent-b')
  const remaining = [scratch, agentA, agentB]
  // 引擎已选同类 agent-b
  expect(selectSameModeCloseFallback(remaining, tab('agent-x'), true, ['agent-b'], 'agent-b')).toBeNull()
  // 关闭工作 Tab（preview）
  const preview: TabItem = { ...tab('p1'), type: 'preview' }
  expect(selectSameModeCloseFallback(remaining, preview, true, ['agent-b'], 'agent-b')).toBeNull()
  // 非激活关闭（active 没变）
  expect(selectSameModeCloseFallback(remaining, tab('agent-x'), false, ['chat-c'], 'chat-c')).toBeNull()
})
