/**
 * sidebar-utils.ts — 侧边栏纯函数工具
 *
 * 从 LeftSidebar.tsx 抽离的零依赖纯函数：计数格式化、项目排序、日期分组、
 * 相对时间、rail 首字母、Set 不可变操作、列表渐进切片等。不依赖任何 React/atom。
 */

import { cn } from '@/lib/utils'
import type { WorkspaceSortMode } from '@/atoms/sidebar-atoms'
import type { AppMode } from '@/atoms/app-mode'
import type { TabItem } from '@/atoms/tab-atoms'
import type { AgentSessionMeta, ConversationMeta } from '@profer/shared'
import { buildAgentSessionTrees } from './session-tree'

export type OpenSessionEntry =
  | { type: 'chat'; tab: TabItem; conversation: ConversationMeta }
  | { type: 'agent'; tab: TabItem; session: AgentSessionMeta }

/** 当前会话只统计可渲染入口；关联子会话与项目树采用同一根节点口径。 */
export function getOpenSessionEntries(
  mode: AppMode,
  tabs: readonly TabItem[],
  conversations: readonly ConversationMeta[],
  agentSessions: AgentSessionMeta[],
): OpenSessionEntry[] {
  if (mode !== 'chat' && mode !== 'agent') return []
  const conversationById = new Map(conversations.map((item) => [item.id, item]))
  const rootSessionById = new Map(buildAgentSessionTrees(agentSessions).map((item) => [item.session.id, item.session]))
  const seen = new Set<string>()
  const entries: OpenSessionEntry[] = []

  for (const tab of tabs) {
    if (tab.type !== mode || seen.has(tab.sessionId)) continue
    if (mode === 'chat') {
      const conversation = conversationById.get(tab.sessionId)
      if (!conversation) continue
      entries.push({ type: 'chat', tab, conversation })
    } else {
      const session = rootSessionById.get(tab.sessionId)
      if (!session) continue
      entries.push({ type: 'agent', tab, session })
    }
    seen.add(tab.sessionId)
  }
  return entries
}

export function formatAutomationCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/** 项目排序方式循环顺序（default → recent → name → default） */
export const WORKSPACE_SORT_ORDER: readonly WorkspaceSortMode[] = ['default', 'recent', 'name']

/** 项目排序方式对应的中文标签 */
export const WORKSPACE_SORT_LABEL: Record<WorkspaceSortMode, string> = {
  default: '默认',
  recent: '最近',
  name: '名称',
}

/** 项目名称排序用 collator：中文按拼音、数字按数值、忽略大小写 */
export const workspaceNameCollator = new Intl.Collator('zh-Hans-CN', {
  numeric: true,
  sensitivity: 'base',
})

/** 获取下一次点击后的排序方式 */
export function getNextWorkspaceSortMode(current: WorkspaceSortMode): WorkspaceSortMode {
  const index = WORKSPACE_SORT_ORDER.indexOf(current)
  return WORKSPACE_SORT_ORDER[(index + 1) % WORKSPACE_SORT_ORDER.length] ?? 'default'
}

/** 日期分组标签 */
export type DateGroup = '今天' | '昨天' | '更早'

export function formatRelativeUpdatedAt(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟`
  if (diff < day) return `${Math.floor(diff / hour)} 小时`
  if (diff < month) return `${Math.floor(diff / day)} 天`
  if (diff < year) return `${Math.floor(diff / month)} 月`
  return `${Math.floor(diff / year)} 年`
}

/** 按 updatedAt 将项目分为 今天 / 昨天 / 更早 三组 */
export function groupByDate<T extends { updatedAt: number }>(items: T[]): Array<{ label: DateGroup; items: T[] }> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const today: T[] = []
  const yesterday: T[] = []
  const earlier: T[] = []

  for (const item of items) {
    if (item.updatedAt >= todayStart) {
      today.push(item)
    } else if (item.updatedAt >= yesterdayStart) {
      yesterday.push(item)
    } else {
      earlier.push(item)
    }
  }

  const groups: Array<{ label: DateGroup; items: T[] }> = []
  if (today.length > 0) groups.push({ label: '今天', items: today })
  if (yesterday.length > 0) groups.push({ label: '昨天', items: yesterday })
  if (earlier.length > 0) groups.push({ label: '更早', items: earlier })
  return groups
}

/** 不可变地切换 Set 中某个成员的存在状态（存在则删除，不存在则添加），返回新 Set */
export function toggleSetEntry<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

/** 不可变地从 Set 中移除某个成员，若不存在则原样返回 */
export function deleteSetEntry<T>(prev: Set<T>, value: T): Set<T> {
  if (!prev.has(value)) return prev
  const next = new Set(prev)
  next.delete(value)
  return next
}

/**
 * 侧栏行统一外观（会话 / 项目 / 入口共用）。
 *
 * 只统一 className，不抽组件：ConversationItem 内含编辑态、右键菜单、中键关闭、
 * 迷你地图预览与 F2 快捷键，抽组件会强制重排这些逻辑，风险大于收益。
 *
 * 约定：行高 28（项目 32），圆角 7，左右内边距 8，子会话缩进（块左 4 + 文字 26）；
 * 除 focus ring 外不使用描边与阴影，层级只靠背景灰度与文字灰度区分。
 * 会话行与入口行同为默认行：不常显底色、不画分隔线，行间距靠列表 gap；
 * 有色标的会话由调用方（AgentSessionItem）另加同色相淡底色。
 * 灰度层级：项目行 5%（当前 9%）> 会话行当前 7% > 入口行无底色。
 */
export function sidebarRowClass(options: {
  active?: boolean
  /** 1 = 项目内的会话行（左侧留出层级缩进） */
  depth?: 0 | 1
  /** 已归档等次要行 */
  muted?: boolean
  /** 项目行等 32px 行 */
  tall?: boolean
} = {}): string {
  const { active, depth = 0, muted, tall } = options
  return cn(
    // shrink-0：行必须保持固定高度。列表容器有 max-height 时（当前会话区 144px），
    // flex 子项默认会被压扁去「塞进」容器，导致行高从 28px 塌成 20px 左右且不再滚动。
    'group relative flex w-full shrink-0 items-center gap-2 rounded-[7px] px-2 text-[13px] transition-colors duration-100',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
    tall ? 'h-8' : 'h-[28px]',
    depth === 1 && 'ml-1 w-[calc(100%-0.25rem)] pl-[26px]',
    active
      ? tall
        ? 'bg-foreground/[0.09] text-foreground'
        : 'bg-foreground/[0.07] text-foreground'
      : muted
        ? 'text-foreground/[0.38] hover:bg-foreground/[0.04] hover:text-foreground/[0.62]'
        : tall
          ? 'bg-foreground/[0.05] text-foreground/[0.62] hover:bg-foreground/[0.07] hover:text-foreground'
          : 'text-foreground/[0.62] hover:bg-foreground/[0.04] hover:text-foreground',
  )
}

/** 侧栏分区标题（当前会话 / 置顶 / 项目 / 今天…）统一外观 */
export const SIDEBAR_SECTION_TITLE_CLASS =
  'text-[11px] font-medium text-foreground/[0.38] select-none'

/**
 * 列表渐进渲染辅助：按累计条数切分组列表（先渲染可见数量，空闲时补全）。
 * 避免切换模式/视图时全量渲染大量会话导致主线程卡顿。
 */
export function sliceGroupsByCount<T extends { items: readonly unknown[] }>(groups: readonly T[], count: number): T[] {
  let remaining = count
  const out: T[] = []
  for (const group of groups) {
    if (remaining <= 0) break
    if (group.items.length <= remaining) {
      out.push(group)
      remaining -= group.items.length
    } else {
      out.push({ ...group, items: group.items.slice(0, remaining) })
      remaining = 0
    }
  }
  return out
}
