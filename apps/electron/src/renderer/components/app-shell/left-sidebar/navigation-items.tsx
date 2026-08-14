/**
 * navigation-items.tsx — 侧边栏导航小件
 *
 * 从 LeftSidebar.tsx 抽离的导航条目组件与相关常量：
 * - 自动任务 / Agent 技能入口条目
 * - 窗口拖拽条
 * - 全屏视图焦点移交辅助
 */

import * as React from 'react'
import { CalendarDays, Blocks, History, ArrowDownAZ } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceSortMode } from '@/atoms/sidebar-atoms'
import { formatAutomationCount } from './sidebar-utils'

/** 渲染项目排序按钮的图标（三种排序方式三种图标） */
export function renderWorkspaceSortIcon(mode: WorkspaceSortMode): React.ReactElement {
  switch (mode) {
    case 'recent':
      return <History size={14} />
    case 'name':
      return <ArrowDownAZ size={14} />
    default:
      return <CalendarDays size={14} />
  }
}

export const SIDEBAR_DRAG_STRIP_HEIGHT = {
  collapsedMac: 50,
  expandedMac: 30,
  collapsed: 8,
  expanded: 4,
} as const

interface AutomationSidebarEntryProps {
  count: number
  active: boolean
  onClick: () => void
}

export function AutomationSidebarEntry({ count, active, onClick }: AutomationSidebarEntryProps): React.ReactElement {
  return (
    <button
      type="button"
      data-profer-navigation-item="planning"
      aria-label={`自动任务，${count} 个任务已创建`}
      onClick={onClick}
      className={cn(
        'group w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] transition-colors duration-100 titlebar-no-drag automation-entry',
        active
          ? 'automation-entry-selected bg-accent-foreground/[0.10] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
          : 'text-foreground/60 hover:bg-accent-foreground/[0.08] hover:text-foreground',
      )}
    >
      <span className="flex items-center gap-3 min-w-0">
        <span className={cn('flex-shrink-0 w-[18px] h-[18px] automation-entry-icon', active ? 'text-accent-foreground' : 'text-foreground/45')}>
          <CalendarDays size={16} className="block" />
        </span>
        <span className="truncate">规划中心</span>
      </span>
      <span
        className={cn(
          'ml-2 flex h-5 min-w-[22px] flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums automation-entry-badge',
          active
            ? 'bg-accent-foreground/[0.26] text-primary-foreground'
            : 'bg-foreground/[0.045] text-foreground/[0.42] group-hover:text-foreground/65',
        )}
      >
        {formatAutomationCount(count)}
      </span>
    </button>
  )
}

interface SkillsSidebarEntryProps {
  count: number
  updateCount: number
  active: boolean
  onClick: () => void
}

export function SkillsSidebarEntry({ count, updateCount, active, onClick }: SkillsSidebarEntryProps): React.ReactElement {
  const hasUpdate = updateCount > 0
  return (
    <button
      type="button"
      aria-label={`Agent 技能，${count} 个能力${hasUpdate ? `，${updateCount} 个可更新` : ''}`}
      data-profer-navigation-item="agent-skills"
      onClick={onClick}
      className={cn(
        'group w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] transition-colors duration-100 titlebar-no-drag',
        active
          ? 'bg-accent-foreground/[0.10] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
          : 'text-foreground/60 hover:bg-accent-foreground/[0.08] hover:text-foreground',
      )}
    >
      <span className="flex items-center gap-3 min-w-0">
        <span className={cn('flex-shrink-0 w-[18px] h-[18px]', active ? 'text-accent-foreground' : 'text-foreground/45')}>
          <Blocks size={16} className="block" />
        </span>
        <span className="truncate">Agent 技能</span>
      </span>
      <span
        className={cn(
          'ml-2 flex h-5 min-w-[22px] flex-shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums',
          hasUpdate
            ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
            : active
              ? 'bg-accent-foreground/[0.26] text-primary-foreground'
              : 'bg-foreground/[0.045] text-foreground/[0.42] group-hover:text-foreground/65',
        )}
      >
        {formatAutomationCount(count)}
      </span>
    </button>
  )
}

export function SidebarWindowDragStrip({ height }: { height: number }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="sidebar-window-drag-strip"
      style={{ height }}
    />
  )
}

/** 全屏可进入视图（规划中心 / Agent 技能）对应的 navigation-region 选择器 */
export function enterableViewSelector(item: string): string | null {
  if (item === 'planning') return '[data-profer-navigation-region="planning"]'
  if (item === 'agent-skills') return '[data-profer-navigation-region="agent-skills"]'
  return null
}

/** 进入全屏视图后把焦点移交进其内容区，让用户能在视图内继续用方向键/手柄操作。
 *  React 渲染是异步的，点击触发视图切换后需等下一帧再聚焦，否则找不到刚渲染的 region。
 *  对 agent-skills 优先聚焦当前激活的顶部 tab（Skills/市场/MCP/记忆，默认进入即 Skills），
 *  因为 region 内首个可聚焦控件是工作区切换下拉，不是 tab。 */
export function focusEnterableViewItem(item: string): void {
  const selector = enterableViewSelector(item)
  if (!selector) return
  requestAnimationFrame(() => {
    const region = document.querySelector<HTMLElement>(selector)
    let target: HTMLElement | null | undefined
    // 技能页：优先激活 tab（或默认 Skills）
    if (item === 'agent-skills') {
      target = region?.querySelector<HTMLElement>(
        '[data-agent-skill-tab][aria-selected="true"]',
      ) ?? region?.querySelector<HTMLElement>('[data-agent-skill-tab="skills"]')
    }
    if (!target) {
      // 通用回退：region 内首个 focusable（tablist/按钮等）；无则可聚焦的 region 容器（tabIndex=-1）。
      target = region?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="tab"]',
      ) ?? region
    }
    if (target) {
      target.focus()
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  })
}
