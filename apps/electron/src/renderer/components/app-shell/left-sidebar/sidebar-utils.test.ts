import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, ConversationMeta } from '@profer/shared'
import type { TabItem } from '@/atoms/tab-atoms'
import { getOpenSessionEntries, limitSessionLeadingMarkers, resolveDeleteShortcutAction, resolveSessionLeadingMarkers, sidebarRowClass } from './sidebar-utils'

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

describe('ExpandedSidebar — 当前会话区域按设置挂载', () => {
  test('Given 关闭当前会话显示 When 渲染侧栏 Then 当前会话计算与关闭处理器随子组件卸载', () => {
    const source = readFileSync(new URL('./expanded-sidebar.tsx', import.meta.url), 'utf8')
    const sectionStart = source.indexOf('function CurrentSessionSection')
    const parentStart = source.indexOf('export function ExpandedSidebar')
    const section = source.slice(sectionStart, parentStart)
    const parent = source.slice(parentStart)

    expect(sectionStart).toBeGreaterThanOrEqual(0)
    expect(parentStart).toBeGreaterThan(sectionStart)
    expect(section).toContain('useCloseTab()')
    expect(section).toContain('getOpenSessionEntries(')
    expect(parent).toContain('{showCurrentSessionSection && <CurrentSessionSection s={s} />}')
    expect(parent).not.toContain('useCloseTab()')
    expect(parent).not.toContain('getOpenSessionEntries(')
  })
})

describe('ExpandedSidebar — 当前会话区容量与下方保底', () => {
  test('Given 容量可配置 When 渲染侧栏 Then 不再写死 144px 且下方主区有 min-height 保底', () => {
    const source = readFileSync(new URL('./expanded-sidebar.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('max-h-[144px]')
    expect(source).toContain('currentSessionVisibleCountAtom')
    expect(source).toContain('buildCurrentSessionMaxHeight(')
    expect(source).toContain('overflow-y-auto')
    // chat active / agent active / 归档视图三处主区都要保底
    expect(source.match(/min-h-\[160px\]/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('ExpandedSidebar — 当前会话拖拽重排接线', () => {
  test('Given 左侧把手 When 重排当前会话 Then 状态在 hook 里、视图只负责渲染', () => {
    const source = readFileSync(new URL('./expanded-sidebar.tsx', import.meta.url), 'utf8')
    const hook = readFileSync(new URL('../../../hooks/use-current-session-reorder.ts', import.meta.url), 'utf8')
    const items = readFileSync(new URL('./session-items.tsx', import.meta.url), 'utf8')

    // 视图：接线与视觉契约
    expect(source).toContain('useCurrentSessionReorder()')
    expect(source).toContain('data-profer-reorder-handle')
    expect(source).toContain('aria-hidden="true"')
    expect(source).not.toContain('useSetAtom(tabsAtom)')
    // 让位由 state 驱动：停留 100ms 或重排态，快速扫过不触发；不再依赖 :hover
    expect(source).toContain('reorder.isReordering || reorder.hoveredTabId === tab.id')
    expect(source).not.toContain('hover:pl-5')
    expect(source).toContain('onMouseEnter={() => reorder.onRowMouseEnter(tab.id)}')
    expect(source).toContain('onMouseLeave={reorder.onRowMouseLeave}')
    expect(source).toContain('inset-y-0 left-0')
    expect(source).toContain('w-5 cursor-grab')
    expect(source).toContain('pointer-events-none')
    // 容器级接管 dragenter / dragover / drop：行间 gap 与空白处不会闪禁止光标
    expect(source).toContain('onDragEnter={reorder.onListDragEnter}')
    expect(source).toContain('onDragOver={reorder.onListDragOver}')
    expect(source).toContain('onDrop={reorder.onListDrop}')
    expect(source).not.toContain('onRowDragLeave')
    // 指示线画在行内边缘：第一行上方 / 最后一行下方不会被 overflow-y-auto 裁掉
    expect(source).toContain("indicator.position === 'before' ? 'top-0' : 'bottom-0'")
    expect(source).not.toContain('-top-0.5')

    // hook：按 tab.id 换算真实索引、写回 tabsAtom，drop 时用事件坐标重算插入位置
    expect(hook).toContain('useSetAtom(tabsAtom)')
    expect(hook).toContain('resolveReorderTargetIndex(previous, dragged, target.tabId, target.position)')
    expect(hook).toContain('reorderTabs(previous, fromIndex, insertIndex)')
    expect(hook).toContain('resolveReorderDropPosition(e.clientY, rect.top, rect.height)')
    expect(hook).toContain('acceptCurrentSessionReorderDrag(e)')
    expect(hook).toContain('e.stopPropagation()')
    // hover 延迟：定时器在离开、dragstart 与卸载时都要清理
    expect(hook).toContain('REORDER_HOVER_DELAY_MS = 100')
    expect(hook).toContain('clearHoverTimer')
    expect(hook).toContain('React.useEffect(() => () => clearHoverTimer(), [clearHoverTimer])')
    // 插入点规范化：相邻两行边界只对应一根线，dragover 与 drop 同口径
    expect(source).toContain('openSessionEntries[index + 1]?.tab.id ?? null')
    expect(hook).toContain('normalizeDropTarget(tabId, position, nextTabId)')
    expect(hook).toContain('normalizeDropTarget(targetTabId, position, nextTabId)')
    // 把手是行组件的兄弟，行体拖作引用的入口原封不动
    expect(items).toContain('setSessionReferenceDragData(')
  })
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

  test('Given 项目内会话 When 生成 Then 不再预留标记留白且不影响默认行', () => {
    const cls = sidebarRowClass({ depth: 1 })
    expect(cls).not.toContain('pl-[30px]')
    expect(cls).toContain('pl-2')
    expect(sidebarRowClass({ depth: 0 })).not.toContain('pl-[30px]')
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

  test('Given 项目内会话行 When 生成 Then 无底色、无分隔线，仅 hover 给灰', () => {
    const session = sidebarRowClass({ depth: 1 })
    const tokens = session.split(' ')
    expect(tokens.some((t) => t.startsWith('bg-foreground/'))).toBe(false)
    expect(tokens.some((t) => t.startsWith('after:'))).toBe(false)
    // 行间分隔只靠列表 gap，hover 仍给一层极淡底色便于定位
    expect(session).toContain('hover:bg-foreground/[0.04]')
  })

  test('Given 会话行处于当前项 When 生成 Then 只有选中态带底色', () => {
    const activeSession = sidebarRowClass({ depth: 1, active: true })
    expect(activeSession).toContain('bg-foreground/[0.07]')
    expect(activeSession).not.toContain('bg-foreground/[0.03]')
  })

  test('Given 项目行 When 生成 Then 常显底色比会话行深、当前项目更深', () => {
    const project = sidebarRowClass({ tall: true })
    // 用行首/空格边界匹配：默认行与 muted 行带 hover:bg-foreground/[0.04]，只比子串会误判
    expect(project).toMatch(/(?:^|\s)bg-foreground\/\[0\.04\]/)
    expect(project).toContain('hover:bg-foreground/[0.07]')

    const currentProject = sidebarRowClass({ tall: true, active: true })
    expect(currentProject).toContain('bg-foreground/[0.09]')
    // 入口行（非会话、非项目）保持无底色
    expect(sidebarRowClass()).not.toMatch(/(?:^|\s)bg-foreground\/\[0\.04\]/)
  })
})

describe('resolveSessionLeadingMarkers — 行首标记固定顺序', () => {
  const base = {
    pinnable: true,
    pinned: false,
    showPinIcon: true,
    hasBrowser: false,
    regeneratingTitle: false,
  }

  test('Given 没有任何标记 When 解析 Then 不占位（空数组）', () => {
    expect(resolveSessionLeadingMarkers(base)).toEqual([])
  })

  test('Given 置顶且开着浏览器 When 解析 Then 置顶在前、浏览器在后', () => {
    expect(resolveSessionLeadingMarkers({ ...base, pinned: true, hasBrowser: true }))
      .toEqual(['pin', 'browser'])
  })

  test('Given 标记全开 When 解析 Then 固定为 置顶→定时→探索→浏览器→生成标题', () => {
    expect(resolveSessionLeadingMarkers({
      ...base,
      pinned: true,
      sourceAutomationId: 'auto-1',
      explorationParentSessionId: 'parent-1',
      explorationSourceMessageId: 'msg-1',
      hasBrowser: true,
      regeneratingTitle: true,
    })).toEqual(['pin', 'automation', 'exploration', 'browser', 'regeneratingTitle'])
  })

  test('Given 委派子会话 When 解析 Then 显示委派标记且不出现置顶标记', () => {
    expect(resolveSessionLeadingMarkers({
      ...base,
      pinnable: false,
      pinned: true,
      sourceAutomationId: 'auto-1',
      sourceDelegationId: 'parent-1',
    })).toEqual(['delegation'])
  })

  test('Given 置顶分区（分区标题已表达状态）When 解析 Then 不重复画置顶标记', () => {
    expect(resolveSessionLeadingMarkers({ ...base, pinned: true, showPinIcon: false })).toEqual([])
  })
})

describe('resolveSessionLeadingMarkers — Goal 身份标记', () => {
  const base = {
    pinnable: true,
    pinned: false,
    showPinIcon: true,
    hasBrowser: false,
    regeneratingTitle: false,
  }

  test('Given 有进行中的 Goal When 解析 Then 靶心排在置顶之后、定时之前', () => {
    expect(resolveSessionLeadingMarkers({ ...base, pinned: true, goalStatus: 'active' }))
      .toEqual(['pin', 'goal'])
  })

  test('Given Goal 未结束（暂停/受阻/预算耗尽/停止中）When 解析 Then 仍然显示标记', () => {
    for (const status of ['paused', 'blocked', 'budget_limited', 'stopping'] as const) {
      expect(resolveSessionLeadingMarkers({ ...base, goalStatus: status })).toEqual(['goal'])
    }
  })

  test('Given Goal 已结束 When 解析 Then 不再显示标记（结果已由左侧竖条表达）', () => {
    for (const status of ['completed', 'stopped', 'failed'] as const) {
      expect(resolveSessionLeadingMarkers({ ...base, goalStatus: status })).toEqual([])
    }
  })

  test('Given 既有定时来源又有未结束 Goal When 解析 Then 只留 Goal 一种驱动源', () => {
    expect(resolveSessionLeadingMarkers({
      ...base,
      sourceAutomationId: 'auto-1',
      hasBrowser: true,
      goalStatus: 'active',
    })).toEqual(['goal', 'browser'])
  })

  test('Given Goal 已结束且来源是定时任务 When 解析 Then 回落到定时标记', () => {
    expect(resolveSessionLeadingMarkers({
      ...base,
      sourceAutomationId: 'auto-1',
      goalStatus: 'completed',
    })).toEqual(['automation'])
  })
})

describe('limitSessionLeadingMarkers — 行首标记容量上限', () => {
  test('Given 不超过上限 When 切分 Then 全部可见且不折叠', () => {
    expect(limitSessionLeadingMarkers(['pin', 'goal', 'browser']))
      .toEqual({ visible: ['pin', 'goal', 'browser'], overflow: [] })
  })

  test('Given 超过上限 When 切分 Then 按顺序保留前三枚、其余折叠成 +N', () => {
    expect(limitSessionLeadingMarkers(['pin', 'goal', 'automation', 'browser', 'regeneratingTitle']))
      .toEqual({
        visible: ['pin', 'goal', 'automation'],
        overflow: ['browser', 'regeneratingTitle'],
      })
  })

  test('Given 瞬时标记排在末尾 When 溢出 Then 优先被折叠的是浏览器与生成标题', () => {
    expect(limitSessionLeadingMarkers(['pin', 'goal', 'delegation', 'browser']).overflow)
      .toEqual(['browser'])
  })
})
describe('resolveDeleteShortcutAction', () => {
  test('Given 确认框未打开且有可删除的活跃会话 When 按 Delete Then 打开', () => {
    expect(resolveDeleteShortcutAction(null, 'session-a')).toBe('open')
  })

  test('Given 确认框已打开 When 再按 Delete Then 关闭', () => {
    expect(resolveDeleteShortcutAction('session-a', 'session-a')).toBe('close')
  })

  test('Given 确认框已打开但活跃会话已切换 When 再按 Delete Then 仍先关闭', () => {
    expect(resolveDeleteShortcutAction('session-a', 'session-b')).toBe('close')
  })

  test('Given 无可删除的活跃会话（未选中 / 草稿） When 按 Delete Then 不响应', () => {
    expect(resolveDeleteShortcutAction(null, null)).toBe('none')
  })
})
