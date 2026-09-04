/**
 * sidebar-utils.ts — 侧边栏纯函数工具
 *
 * 从 LeftSidebar.tsx 抽离的零依赖纯函数：计数格式化、项目排序、日期分组、
 * 相对时间、rail 首字母、Set 不可变操作、列表渐进切片等。不依赖任何 React/atom。
 */

import type { WorkspaceSortMode } from '@/atoms/sidebar-atoms'

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

export function getRailInitial(title: string): string {
  return title.trim().slice(0, 1).toUpperCase() || '·'
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
