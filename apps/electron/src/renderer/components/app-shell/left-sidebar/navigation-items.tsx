/**
 * navigation-items.tsx — 侧边栏导航小件
 *
 * 从 LeftSidebar.tsx 抽离的导航条目组件与相关常量：
 * - rail 常驻图标条目（规划中心 / Agent 技能 / 插件等共用一套外观）
 * - 窗口拖拽条
 * - 全屏视图焦点移交辅助
 */

import * as React from 'react'
import { CalendarDays, History, ArrowDownAZ } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@profer/ui/primitives/tooltip'
import type { WorkspaceSortMode } from '@/atoms/sidebar-atoms'
import type { PlanningTab } from '@/atoms/planning-atoms'
import { TOPBAR_CONTENT_HEIGHT, TOPBAR_CONTENT_OFFSET } from '@/components/tabs/topbar-layout'

/** 规划中心拆成三个 rail 入口后，各入口的 navigation-item 标识。 */
export const PLANNING_NAV_ITEM: Record<PlanningTab, string> = {
  todos: 'planning-todos',
  calendar: 'planning-calendar',
  automations: 'planning-automations',
  goals: 'planning-goals',
}

/** 把 rail 入口标识还原成规划中心分区；非规划入口返回 null。 */
export function planningSectionOf(item: string | undefined): PlanningTab | null {
  if (item === PLANNING_NAV_ITEM.todos) return 'todos'
  if (item === PLANNING_NAV_ITEM.calendar) return 'calendar'
  if (item === PLANNING_NAV_ITEM.automations) return 'automations'
  if (item === PLANNING_NAV_ITEM.goals) return 'goals'
  return null
}

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

/**
 * 侧栏列表容器的顶边 = Tab 标签本体的下沿。
 *
 * 主区 p-2（8）+ TabBar 内容行偏移（1）+ 内容行高度（37）= 46。
 * 用「标签本体」而不是 40px 外框的底边（48）：视觉上对的是那颗 Tab 的下沿，
 * 外框底部还有 2px 的留白 gutter，对齐它反而会多出 2px 缝。
 * macOS 与 Windows 的 TabBar 几何一致，但这个值只在 macOS 生效：Windows 顶部没有
 * 红绿灯，侧栏不需要给顶栏让位，LeftSidebar 会直接取 0（见那里的说明）。
 */
export const SIDEBAR_PANEL_TOP = 8 + TOPBAR_CONTENT_OFFSET + TOPBAR_CONTENT_HEIGHT

/**
 * 列表行与上下分隔线之间的间距。
 *
 * 必须与「新建行 → 分隔线」的 7px 同值，否则首行 hover 背景上下留白不对称。
 */
export const SIDEBAR_ROW_GAP = 7

/**
 * rail 图标列的顶部留白。
 *
 * ModeSwitcher 的 pt-2（8px）+ 轨道 40px 是列表表头；rail 按钮 36px，
 * 取 8 + (40 - 36) / 2 = 10，让第一个图标与分段控件光学居中在同一条带上。
 */
export const SIDEBAR_HEADER_INSET = 10

/** rail 图标按钮：36×36、圆角 9、间距 3；不用描边和阴影 */
export const RAIL_BUTTON_CLASS =
  'relative flex size-[36px] flex-none items-center justify-center rounded-[9px] transition-colors duration-100 titlebar-no-drag focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
export const RAIL_BUTTON_ACTIVE_CLASS = 'bg-foreground/[0.085] text-foreground'
export const RAIL_BUTTON_IDLE_CLASS =
  'text-foreground/[0.58] hover:bg-foreground/[0.045] hover:text-foreground/[0.82]'

interface SidebarRailEntryProps {
  icon: React.ReactNode
  /** 无障碍名称 */
  label: string
  /** 悬停提示（可带快捷键 / 计数） */
  tooltip: React.ReactNode
  active?: boolean
  /** 右上角小圆点：更新提示 */
  dot?: boolean
  onClick: () => void
  navigationItem?: string
  dataTour?: string
}

/**
 * rail 上的单个图标入口。
 *
 * 旧实现里「规划中心 / Agent 技能」在展开栏与 rail 各有一套完全不同的样式
 * （列表里是 14px 文字 + 数字 badge，rail 里是描边按钮）。本组件统一成一套：
 * 选中 = 8.5% 前景底 + 左侧 2px 高亮条，其余状态只靠文字灰度变化。
 */
export function SidebarRailEntry({
  icon,
  label,
  tooltip,
  active = false,
  dot = false,
  onClick,
  navigationItem,
  dataTour,
}: SidebarRailEntryProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          data-profer-navigation-item={navigationItem}
          data-tour={dataTour}
          onClick={onClick}
          className={cn(RAIL_BUTTON_CLASS, active ? RAIL_BUTTON_ACTIVE_CLASS : RAIL_BUTTON_IDLE_CLASS)}
        >
          {active && (
            <span
              aria-hidden="true"
              className="absolute -left-[7px] top-[11px] h-[14px] w-[2px] rounded-[2px] bg-primary"
            />
          )}
          {icon}
          {dot && (
            <span
              aria-hidden="true"
              className="absolute right-[8px] top-[8px] size-[5px] rounded-full bg-primary"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** rail 分组分隔线：18px 宽、1px、前景 7.5%；className 用于个别分隔线微调位置 */
export function RailSeparator({ className }: { className?: string } = {}): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className={cn('my-1.5 h-px w-[18px] flex-none bg-foreground/[0.075]', className)}
    />
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

/** 全屏可进入视图（规划中心三入口 / Agent 技能 / Agent 记忆）对应的 navigation-region 选择器 */
export function enterableViewSelector(item: string): string | null {
  if (planningSectionOf(item)) return '[data-profer-navigation-region="planning"]'
  if (item === 'agent-skills') return '[data-profer-navigation-region="agent-skills"]'
  if (item === 'agent-memory') return '[data-profer-navigation-region="agent-memory"]'
  if (item === 'user-profile') return '[data-profer-navigation-region="user-profile"]'
  if (item === 'user-profile-files') return '[data-profer-navigation-region="user-profile"]'
  return null
}

/** 进入全屏视图后把焦点移交进其内容区，让用户能在视图内继续用方向键/手柄操作。
 *  React 渲染是异步的，点击触发视图切换后需等下一帧再聚焦，否则找不到刚渲染的 region。
 *  对 agent-skills 优先聚焦当前激活的顶部 tab（Skills/市场/MCP/预设，默认进入即 Skills），
 *  因为 region 内首个可聚焦控件是工作区切换下拉，不是 tab。
 *  对 agent-memory 直接聚焦搜索框：进记忆页多半是为了找内容，不是切工作区。 */
export function focusEnterableViewItem(item: string): void {
  const selector = enterableViewSelector(item)
  if (!selector) return
  requestAnimationFrame(() => {
    const region = document.querySelector<HTMLElement>(selector)
    let target: HTMLElement | null | undefined
    // 规划中心：焦点落到当前分区的主动作（新建 Todo / 新建日程 / 新建定时任务），
    // 比落在窗口控制按钮上更接近“进入这个页面要干什么”。
    const planningSection = planningSectionOf(item)
    if (planningSection) {
      target = region?.querySelector<HTMLElement>(
        `[data-planning-primary-action="${planningSection}"]`,
      )
    }
    // 技能页：优先激活 tab（或默认 Skills）
    if (!target && item === 'agent-skills') {
      target = region?.querySelector<HTMLElement>(
        '[data-agent-skill-tab][aria-selected="true"]',
      ) ?? region?.querySelector<HTMLElement>('[data-agent-skill-tab="skills"]')
    }
    // 记忆页：直接落到搜索框
    if (!target && item === 'agent-memory') {
      target = region?.querySelector<HTMLElement>('[data-view-search="agent-memory"]')
    }
    if (!target && item === 'user-profile') {
      target = region?.querySelector<HTMLElement>('[data-user-profile-primary-action]')
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
