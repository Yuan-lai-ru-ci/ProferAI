/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  DEFAULT_CURRENT_SESSION_VISIBLE_COUNT,
  normalizeCurrentSessionVisibleCount,
} from '@/lib/current-session-capacity'

/** 侧边栏视图模式 */
export type SidebarViewMode = 'active' | 'archived'

/** 侧边栏视图模式（active = 显示活跃对话，archived = 显示已归档对话） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/**
 * 左侧栏顶部「当前会话」区域是否显示。
 *
 * 默认显示；关闭后不渲染该区，会话本身与项目列表都不受影响。
 * 属于纯界面偏好，和宽度/高度一样持久化到 localStorage。
 */
export const showCurrentSessionSectionAtom = atomWithStorage<boolean>(
  'profer-sidebar-show-current-session',
  true,
)

/** 项目列表排序方式 */
export type WorkspaceSortMode = 'default' | 'recent' | 'name'

/** 项目列表排序方式（default = 默认/创建时间，recent = 最近更新，name = 名称） */
export const workspaceSortModeAtom = atomWithStorage<WorkspaceSortMode>(
  'profer-workspace-sort-mode',
  'default',
)

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'profer-workspace-list-height',
  120,
)

/**
 * 左侧栏「列表」宽度（px），用户可拖拽调整，持久化到 localStorage。
 *
 * 语义：只表示 rail 右侧的列表宽度，不含 54px 常驻 rail。外壳总宽 = 54 + 该值，
 * 默认 246 → 总宽 300，与 lib/panel-layout.ts 的 SIDEBAR_WIDTH 预算一致。
 * 因为语义从「总宽」改成「列表宽」，storage key 升到 v2，避免老用户读到 300 变成 354。
 */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'profer-left-sidebar-width-v2',
  246,
)

/**
 * 左侧栏「当前会话」区最多显示的会话数。
 *
 * 与宽度/高度偏好不同，这一项走 settings.json 而非 localStorage（配置文件为权威）。
 * 朴素 atom + 初始化函数 + 落盘函数，与 `atoms/session-preview-settings.ts` 同一套写法；
 * 读取失败保持默认值，不改变既有行为。
 */
export const currentSessionVisibleCountAtom = atom<number>(DEFAULT_CURRENT_SESSION_VISIBLE_COUNT)

/** 从主进程加载容量数值；读失败保持默认 5（fail-safe） */
export async function initializeCurrentSessionVisibleCount(
  setCount: (count: number) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setCount(normalizeCurrentSessionVisibleCount(settings.currentSessionVisibleCount))
  } catch (error) {
    console.error('[侧栏] 初始化当前会话容量失败:', error)
  }
}

/** 落盘容量档位；调用方先乐观更新 atom，失败由其自行回滚 */
export async function persistCurrentSessionVisibleCount(count: number): Promise<void> {
  await window.electronAPI.updateSettings({
    currentSessionVisibleCount: normalizeCurrentSessionVisibleCount(count),
  })
}
