import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, ConversationMeta } from '@profer/shared'
import type { TabItem } from '@/atoms/tab-atoms'
import { getOpenSessionEntries, sidebarRowClass } from './sidebar-utils'

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

describe('sidebarRowClass — 侧栏行视觉契约', () => {
  test('Given 默认行 When 生成 Then 28px 高、7px 圆角、左右 8px 内边距', () => {
    const cls = sidebarRowClass()
    expect(cls).toContain('h-[28px]')
    expect(cls).toContain('rounded-[7px]')
    expect(cls).toContain('px-2')
    expect(cls).toContain('text-[13px]')
    // 侧栏内不使用描边与阴影，层级只靠灰度
    expect(cls).not.toContain('border')
    expect(cls).not.toContain('shadow')
  })

  test('Given 项目内会话 When 生成 Then 增加 26px 缩进且不影响默认行', () => {
    expect(sidebarRowClass({ depth: 1 })).toContain('pl-[26px]')
    expect(sidebarRowClass({ depth: 0 })).not.toContain('pl-[26px]')
  })

  test('Given 项目内会话 When 生成 Then 块左边界缩进 4px 且宽度同步回收', () => {
    const cls = sidebarRowClass({ depth: 1 })
    expect(cls).toContain('ml-1')
    expect(cls).toContain('w-[calc(100%-0.25rem)]')
    expect(cls).not.toContain('w-full')
    // 顶层行（项目行、入口行）不缩进
    expect(sidebarRowClass({ depth: 0 })).toContain('w-full')
  })

  test('Given 当前项与项目行 When 生成 Then 选中底色与 32px 行高互不干扰', () => {
    expect(sidebarRowClass({ active: true })).toContain('bg-foreground/[0.07]')
    expect(sidebarRowClass({ tall: true })).toContain('h-8')
    expect(sidebarRowClass({ muted: true })).toContain('text-foreground/[0.38]')
  })

  test('Given 会话行与非会话行 When 生成 Then 会话行无底色、只有底边分隔线', () => {
    const session = sidebarRowClass({ session: true })
    expect(session).not.toContain('bg-foreground/[0.03]')
    expect(session).toContain('after:h-px')
    expect(session).toContain('after:bottom-0')
    expect(session).toContain('after:inset-x-2')
    expect(session).toContain('after:bg-foreground/[0.06]')
    // hover 仍给一层极淡底色便于定位
    expect(session).toContain('hover:bg-foreground/[0.04]')
    // 项目行、入口行不带分隔线
    expect(sidebarRowClass({ tall: true })).not.toContain('after:h-px')
    expect(sidebarRowClass()).not.toContain('after:h-px')
  })

  test('Given 会话行处于当前项 When 生成 Then 选中底色仍高于无底色会话行', () => {
    const activeSession = sidebarRowClass({ session: true, active: true })
    expect(activeSession).toContain('bg-foreground/[0.07]')
    expect(activeSession).not.toContain('bg-foreground/[0.03]')
  })

  test('Given 项目行 When 生成 Then 常显底色比会话行深、当前项目更深', () => {
    const project = sidebarRowClass({ tall: true })
    expect(project).toContain('bg-foreground/[0.05]')
    expect(project).toContain('hover:bg-foreground/[0.07]')

    const currentProject = sidebarRowClass({ tall: true, active: true })
    expect(currentProject).toContain('bg-foreground/[0.09]')
    // 入口行（非会话、非项目）保持无底色
    expect(sidebarRowClass()).not.toContain('bg-foreground/[0.05]')
  })
})
