import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, ConversationMeta } from '@profer/shared'
import type { TabItem } from '@/atoms/tab-atoms'
import { getOpenSessionEntries } from './sidebar-utils'

const NOW = 1_752_000_000_000
const session = (id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta => ({
  id, title: id, createdAt: NOW, updatedAt: NOW, ...overrides,
})
const conversation = (id: string): ConversationMeta => ({
  id, title: id, createdAt: NOW, updatedAt: NOW,
})
const tab = (id: string, type: TabItem['type'] = 'agent', sessionId = id): TabItem => ({
  id, type, sessionId, title: id,
})

describe('getOpenSessionEntries — 当前会话列表与计数共用数据', () => {
  test('Given 失效 Tab 和有效会话 When 解析 Then 数量只包含实际能渲染的行并保留 Tab 顺序', () => {
    const entries = getOpenSessionEntries('agent', [tab('missing'), tab('b'), tab('a')], [], [session('a'), session('b')])
    expect(entries.map((entry) => entry.tab.id)).toEqual(['b', 'a'])
    expect(entries).toHaveLength(2)
  })

  test('Given 同一会话多个入口 When 解析 Then 会话只显示并计数一次且保留首个关闭目标', () => {
    const first = tab('first', 'agent', 'a')
    const entries = getOpenSessionEntries('agent', [first, tab('duplicate', 'agent', 'a')], [], [session('a')])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.tab).toBe(first)
    expect(entries[0]?.type).toBe('agent')
  })

  test('Given 混合类型 Tab When Agent 模式解析 Then 忽略 Chat 和所有工作 Tab', () => {
    const tabs = [tab('a'), tab('c', 'chat'), tab('scratch', 'scratch'), tab('preview', 'preview', 'a'), tab('browser', 'browser', 'a'), tab('plugin', 'plugin', 'a')]
    const entries = getOpenSessionEntries('agent', tabs, [conversation('c')], [session('a')])
    expect(entries.map((entry) => entry.tab.id)).toEqual(['a'])
  })

  test('Given Chat 模式有效与失效对话入口 When 解析 Then 计数与实际对话行一致', () => {
    const chat = conversation('c')
    const entries = getOpenSessionEntries('chat', [tab('a'), tab('missing', 'chat'), tab('c', 'chat'), tab('duplicate', 'chat', 'c')], [chat], [session('a')])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe('chat')
    if (entries[0]?.type === 'chat') expect(entries[0].conversation).toBe(chat)
  })

  test('Given 委派子会话与探索分支 When 解析 Then 与项目树口径一致只列根会话', () => {
    const sessions = [
      session('parent', { workspaceId: 'w1' }),
      session('delegated', { workspaceId: 'w1', parentSessionId: 'parent', sourceDelegationId: 'd1' }),
      session('exploration', { workspaceId: 'w1', explorationParentSessionId: 'parent', explorationSourceMessageId: 'm1' }),
    ]
    const entries = getOpenSessionEntries('agent', sessions.map((item) => tab(item.id)), [], sessions)
    expect(entries.map((entry) => entry.tab.id)).toEqual(['parent'])
  })

  test('Given 孤立子会话和跨项目子会话 When 解析 Then 与项目树一样保留独立可见入口', () => {
    const sessions = [
      session('parent', { workspaceId: 'w1' }),
      session('orphan', { workspaceId: 'w1', parentSessionId: 'missing', sourceDelegationId: 'd1' }),
      session('cross-project', { workspaceId: 'w2', explorationParentSessionId: 'parent', explorationSourceMessageId: 'm1' }),
    ]
    const entries = getOpenSessionEntries('agent', sessions.map((item) => tab(item.id)), [], sessions)
    expect(entries.map((entry) => entry.tab.id)).toEqual(['parent', 'orphan', 'cross-project'])
  })

  test('Given 草稿本模式或没有有效会话 When 解析 Then 当前会话计数为零', () => {
    expect(getOpenSessionEntries('scratch', [tab('a')], [], [session('a')])).toEqual([])
    expect(getOpenSessionEntries('agent', [tab('missing')], [], [])).toEqual([])
    expect(getOpenSessionEntries('chat', [], [], [])).toEqual([])
  })
})
