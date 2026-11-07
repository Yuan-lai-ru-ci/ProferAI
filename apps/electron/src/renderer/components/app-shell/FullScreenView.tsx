/**
 * FullScreenView — rail 全屏页的统一骨架
 *
 * rail 上的页面（Todo / 日程 / 定时任务 / Agent 技能 / Agent 记忆 / 我的画像及其二级页）
 * 整块取代 TabBar，因此每页都必须自己解决同样的三件事：
 *   1. 顶部 56px 留给窗口拖拽；
 *   2. Windows 上声明窗口按钮宿主（漏了整组按钮会消失）；
 *   3. 标题区 / 工具条 / 内容区共用同一组宽度与内边距。
 *
 * 2026-11 之前这三件事由各页各写一遍，结果是：标题字号从 12px 到 24px 不等、
 * 返回按钮有的是图标有的是文字、窗口按钮有的绝对定位有的挤在流内、
 * 内容宽度在 6xl / 1440 / 不限宽之间随意取值。现在统一收敛到本文件，
 * 页面只负责内容和自己的动作按钮。
 *
 * 规范见 docs/design/2026-11-07-rail-view-header-spec.md
 */

import * as React from 'react'
import { ArrowLeft, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { detectIsWindows } from '@profer/ui'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { resolveWindowControlsRightInset } from '@/lib/window-controls-layout'

/** 顶部拖拽带高度：窗口按钮所在的高度带，页面标题从这条带子下方开始。 */
export const VIEW_DRAG_BAND_HEIGHT = 56

/**
 * 内容宽度两档，header / toolbar / body 必须同档。
 * - standard：所有 rail 页共用的内容宽度（技能、记忆、记忆文件、我的画像）
 * - full：数据密集型工作台（规划中心的日历与看板），不设上限
 *
 * 只有两档是刻意的：content 页宽度一多档，用户就会看到「这个页面比那个窄一点」，
 * 而这种差异没有语义，只是历史实现的残留。
 */
export type ViewWidth = 'standard' | 'full'

const VIEW_WIDTH_CLASS: Record<ViewWidth, string> = {
  standard: 'max-w-[1440px]',
  full: 'max-w-none',
}

/** 标题区、工具条、内容区共用同一组水平内边距——三者的左缘必须对齐。 */
export const VIEW_GUTTER_CLASS = 'px-4 sm:px-6 lg:px-8'

/** 页头宽度 + 内边距，页面私有容器也要对齐时用它。 */
export function viewContentWidthClass(width: ViewWidth = 'standard'): string {
  return cn('mx-auto w-full', VIEW_WIDTH_CLASS[width], VIEW_GUTTER_CLASS)
}

interface FullScreenViewProps {
  /** 导航焦点分区标识，供方向键导航与「进入视图后移交焦点」使用。 */
  region: string
  /** 窗口按钮宿主 id：同一时刻只有优先级最高的宿主渲染按钮。 */
  controlsId: string
  children: React.ReactNode
  className?: string
}

/**
 * 全屏页外壳：内容区底色 + 顶部拖拽带 + 窗口按钮宿主。
 * 页面内容一律从这里开始，不要再自己写 drag-region / WindowControlsHost。
 */
export function FullScreenView({ region, controlsId, children, className }: FullScreenViewProps): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  return (
    <div
      data-profer-navigation-region={region}
      tabIndex={-1}
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden bg-content-area',
        className,
      )}
    >
      {/* 拖拽带必须在窗口按钮前结束：drag 矩形压住 no-drag 按钮矩形时，
          Windows 高 DPI 会把单击判成标题栏点击（见 window-controls-layout.ts）。 */}
      <div
        className="absolute inset-x-0 top-0 z-0 titlebar-drag-region"
        style={{ right: resolveWindowControlsRightInset(isWindows), height: VIEW_DRAG_BAND_HEIGHT }}
        aria-hidden="true"
      />
      <WindowControlsHost id={controlsId} priority={20} className="absolute right-2 top-[3px] z-20" />
      {children}
    </div>
  )
}

export interface ViewBackAction {
  /** 无障碍名称，悬停提示也用它 */
  label: string
  onClick: () => void
}

/** 返回入口：一级 rail 页回对话列表，二级页回上一级。 */
export function ViewBackButton({ label, onClick }: ViewBackAction): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center gap-1 rounded-md text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ArrowLeft size={14} />
      返回
    </button>
  )
}

interface ViewHeaderProps {
  title: string
  /** 标题右侧的一句话说明或行内信息（可交互，过长自行 truncate） */
  subtitle?: React.ReactNode
  /** 紧贴标题的统计 / 计数（chip 形式） */
  meta?: React.ReactNode
  back?: ViewBackAction
  /** 右侧页面级动作：主操作、工作区切换、搜索等 */
  actions?: React.ReactNode
  width?: ViewWidth
  /** 引导浮层的锚点 */
  tourId?: string
  className?: string
}

/**
 * 页头：一行「返回 · 标题 · 说明 · 统计 ·……· 右侧动作」。
 * 标题固定 24px，说明固定 13px 次要色，不允许页面自己改字号。
 */
export function ViewHeader({
  title,
  subtitle,
  meta,
  back,
  actions,
  width = 'standard',
  tourId,
  className,
}: ViewHeaderProps): React.ReactElement {
  return (
    <header
      data-tour={tourId}
      className={cn(
        'titlebar-no-drag flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pb-4',
        viewContentWidthClass(width),
        className,
      )}
      style={{ marginTop: VIEW_DRAG_BAND_HEIGHT }}
    >
      {back && <ViewBackButton {...back} />}
      <h1 className="shrink-0 text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {meta && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{meta}</div>}
      {subtitle && <div className="min-w-0 text-[13px] text-muted-foreground">{subtitle}</div>}
      {actions && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      )}
    </header>
  )
}

/** 工具条：页头下方的第二行（分段切换 + 搜索 + 次级动作），与页头同宽同内边距。 */
export function ViewToolbar({
  width = 'standard',
  children,
  className,
}: {
  width?: ViewWidth
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        'titlebar-no-drag flex shrink-0 flex-wrap items-center gap-2 pb-4',
        viewContentWidthClass(width),
        className,
      )}
    >
      {children}
    </div>
  )
}

/** 内容区：占满剩余高度，与页头同宽同内边距。 */
export function ViewBody({
  width = 'standard',
  scroll = false,
  children,
  className,
}: {
  width?: ViewWidth
  /** 内容整体滚动（列表 / 表单页）；需要内部双栏各自滚动时留 false，自己搭结构 */
  scroll?: boolean
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex min-h-0 w-full flex-1 flex-col',
        scroll && 'profer-scroll-region overflow-y-auto pb-10',
        viewContentWidthClass(width),
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * 页头 / 工具条里的搜索框：全屏页只有这一种搜索外观。
 * 圆角、边框、字号、清空按钮都由这里决定，页面不要再手写。
 */
export function ViewSearchField({
  value,
  onChange,
  placeholder,
  label,
  onSubmit,
  /** 需要显式提交时给搜索框右侧加一颗文字按钮 */
  submitLabel,
  /** 供「进入视图后移交焦点」等处查询的稳定标识，渲染为 data-view-search */
  searchId,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label?: string
  onSubmit?: () => void
  submitLabel?: string
  searchId?: string
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-2.5 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 sm:w-[240px]',
        className,
      )}
    >
      <Search size={13} className="shrink-0 text-foreground/40" />
      <input
        value={value}
        data-view-search={searchId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onSubmit) onSubmit()
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="w-full min-w-0 bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="清空搜索"
          className="shrink-0 rounded p-0.5 text-foreground/40 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X size={13} />
        </button>
      )}
      {onSubmit && submitLabel && (
        <button
          type="button"
          onClick={onSubmit}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {submitLabel}
        </button>
      )}
    </div>
  )
}
