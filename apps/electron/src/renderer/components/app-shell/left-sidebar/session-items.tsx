/**
 * session-items.tsx — 侧边栏列表项子组件
 *
 * 从 LeftSidebar.tsx 整体平移的 React.memo 列表项组件，逻辑保持不变：
 * - safe-tooltip / 操作按钮组（时间、置顶、归档、三点菜单）
 * - 对话行 ConversationItem
 * - Agent 会话行 AgentSessionItem / DelegatedChildSessionItem
 * - 项目分组 AgentProjectGroupItem
 * - 折叠态 rail 的最近会话按钮 RailRecentButton
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  Pin, PinOff, Pencil, Trash2, MoreHorizontal, Clock, GitBranch, Globe, ChevronRight, Cloud, FolderOpen, GripVertical, Settings, ArrowRightLeft, Archive, ArchiveRestore, Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { interfaceVariantAtom } from '@/atoms/theme'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  SessionMiniMapPopover,
  useSessionMiniMapHover,
  type SessionMiniMapType,
} from '@/components/session-preview/SessionMiniMapPopover'
import { browserStateMapAtom } from '@/atoms/browser-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import type { ConversationMeta, AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import { formatRelativeUpdatedAt, getRailInitial } from './sidebar-utils'
import {
  ACTIVE_SESSION_STATUSES,
  ACTIVE_SESSION_STATUS_PRIORITY,
  buildAgentSessionTrees,
  collectTreeSessionIds,
  countCompletedDelegatedChildren,
  getDelegatedChildStatus,
  getSessionTreeStatus,
  treeContainsSessionId,
  type AgentSessionTreeItem,
} from './session-tree'

const PROJECT_SESSION_PREVIEW_LIMIT = 5
// Electron 不提供系统双击间隔；使用保守窗口避免慢双击先打开项目。
const PROJECT_TITLE_DOUBLE_CLICK_DELAY_MS = 500
const PROJECT_SESSION_RECENT_WINDOW_MS = 3 * 86_400_000
/** 点击"显示更多"时每次额外展开的会话数量 */
const PROJECT_SESSION_EXPAND_STEP = 10
/** 置顶区最多占用约 6 条会话的高度，超过后在置顶区内部滚动 */
const PINNED_SESSION_VISIBLE_LIMIT = 6
const PINNED_SESSION_ROW_HEIGHT_PX = 32
export const PINNED_SESSION_MAX_HEIGHT = PINNED_SESSION_VISIBLE_LIMIT * PINNED_SESSION_ROW_HEIGHT_PX

const RAIL_STATUS_CLASS: Record<SessionIndicatorStatus, string> = {
  idle: 'hidden',
  running: 'border-blue-500 animate-pulse',
  blocked: 'border-orange-500',
  completed: 'border-emerald-500',
}

export interface AgentProjectGroup {
  workspace: AgentWorkspace
  sessions: AgentSessionMeta[]
}

export interface RailRecentItem {
  id: string
  title: string
  type: SessionMiniMapType
  initial: string
  active: boolean
  status: SessionIndicatorStatus
  pinned: boolean
  workspaceName?: string
  isAutomation?: boolean
}

export function RailRecentButton({
  item,
  onSelect,
}: {
  item: RailRecentItem
  onSelect: (item: RailRecentItem) => void
}): React.ReactElement {
  const preview = useSessionMiniMapHover()

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={preview.setAnchorRef}
            type="button"
            aria-label={`打开${item.type === 'agent' ? 'Agent 会话' : 'Chat 对话'}：${item.title}`}
            onClick={() => { if (preview.shouldSuppressClick()) return; onSelect(item) }}
            onMouseEnter={preview.handleMouseEnter}
            onMouseLeave={preview.handleMouseLeave}
            onTouchStart={preview.handleTouchStart}
            onTouchMove={preview.handleTouchMove}
            onTouchEnd={preview.handleTouchEnd}
            onTouchCancel={preview.handleTouchCancel}
            className={cn(
              'relative size-10 flex items-center justify-center overflow-hidden rounded-[12px] transition-colors titlebar-no-drag',
              item.active
                ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                : 'text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/80'
            )}
          >
            <span
              className={cn(
                'absolute inset-y-0 left-0 w-0 border-l-[3px] rounded-l-[12px] pointer-events-none',
                RAIL_STATUS_CLASS[item.status]
              )}
            />
            {item.isAutomation
              ? <Clock size={14} className="text-foreground/40" />
              : <span className="text-[13px] font-semibold leading-none">{item.initial}</span>
            }
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {item.type === 'agent' ? 'Agent' : 'Chat'} · {item.title}
        </TooltipContent>
      </Tooltip>
      <SessionMiniMapPopover
        target={{
          type: item.type,
          sessionId: item.id,
          title: item.title,
          workspaceName: item.workspaceName,
        }}
        anchorRef={preview.anchorRef}
        open={preview.isOpen}
        isLeaving={preview.isLeaving}
        onMouseEnter={preview.handlePanelMouseEnter}
        onMouseLeave={preview.handlePanelMouseLeave}
      />
    </>
  )
}

// ===== 列表项操作按钮（时间/置顶/归档/三点菜单） =====

export interface SessionItemActionsProps {
  updatedAt: number
  relativeTimeNow: number
  pinned: boolean
  archived: boolean
  onTogglePin: () => void
  onToggleArchive: () => void
  menuItems: (
    MenuItem: typeof DropdownMenuItem,
    MenuSeparator: typeof DropdownMenuSeparator,
  ) => React.ReactNode
  onMenuOpenChange?: (open: boolean) => void
}

/**
 * 安全 Tooltip：延迟渲染 Content，避开 Popper 初始定位 (0,0) 的闪现。
 *
 * 左侧列表项的操作按钮默认 hidden，hover 时才显示。Radix Popper 在 Content 首次挂载
 * 时若 trigger 尚未完成布局，会先把浮层放到视口左上角 (0,0)，再跳到正确位置。这里
 * 在 Radix 进入打开状态后，先让 Popper 有一小段时间完成定位，再真正渲染 Content；
 * 同时 trigger rect 为 0 时直接不打开。
 */
interface SafeTooltipProps {
  children: React.ReactElement
  content: React.ReactNode
  side?: React.ComponentPropsWithoutRef<typeof TooltipContent>['side']
}

function SafeTooltip({ children, content, side = 'top' }: SafeTooltipProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [showContent, setShowContent] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const getUsableTriggerRect = React.useCallback((): DOMRect | null => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    if (rect.right <= 0 || rect.bottom <= 0) return null
    if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) return null
    return rect
  }, [])

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  const handleOpenChange = React.useCallback((nextOpen: boolean): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (!nextOpen) {
      setOpen(false)
      setShowContent(false)
      return
    }

    // trigger 还没完成布局或已经离开视口时不打开。
    if (!getUsableTriggerRect()) return

    setOpen(true)
    // 先让 Radix 完成 Popper 定位，再渲染 Content，避免看到 (0,0) 初始位置。
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!getUsableTriggerRect()) {
        setOpen(false)
        setShowContent(false)
        return
      }
      setShowContent(true)
    }, 60)
  }, [getUsableTriggerRect])

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild ref={triggerRef}>
        {children}
      </TooltipTrigger>
      {showContent && <TooltipContent side={side} hideWhenDetached>{content}</TooltipContent>}
    </Tooltip>
  )
}

/**
 * 列表项右侧操作区：默认显示相对更新时间，hover 时切换为「置顶 / 归档 / 三点菜单」按钮组。
 * 归档需要二次确认；进入确认态后强制保持按钮可见，避免鼠标移开后用户失去反馈。
 */
export function SessionItemActions({
  updatedAt,
  relativeTimeNow,
  pinned,
  archived,
  onTogglePin,
  onToggleArchive,
  menuItems,
  onMenuOpenChange,
}: SessionItemActionsProps): React.ReactElement {
  const [archiveConfirming, setArchiveConfirming] = React.useState(false)
  // 菜单打开时强制保持按钮组可见：按钮始终保留布局，只切换透明度和 pointer-events。
  // 这样 Radix Popper 不会在 hover 切换瞬间读到 display:none 的 0 尺寸 trigger。
  const [menuOpen, setMenuOpen] = React.useState(false)

  React.useEffect(() => {
    if (!archiveConfirming) return
    const timer = setTimeout(() => setArchiveConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [archiveConfirming])

  const handleArchiveClick = (): void => {
    if (archived) {
      onToggleArchive()
      return
    }
    if (archiveConfirming) {
      setArchiveConfirming(false)
      onToggleArchive()
      return
    }
    setArchiveConfirming(true)
  }

  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setMenuOpen(true)
    } else {
      // Delay hiding the trigger so Radix Popper can still read its rect during the close animation (~150ms).
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        setMenuOpen(false)
      }, 200)
    }
    onMenuOpenChange?.(open)
  }

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const forceVisible = archiveConfirming || menuOpen

  return (
    <div
      className="relative flex-shrink-0 h-[18px] w-[58px]"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        title={`最后更新：${new Date(updatedAt).toLocaleString('zh-CN')}`}
        className={cn(
          'absolute inset-y-0 right-0 block w-full text-right text-[11px] leading-[18px] tabular-nums text-foreground/35 transition-opacity duration-100',
          forceVisible ? 'opacity-0' : 'opacity-100 group-hover:opacity-0',
        )}
      >
        {formatRelativeUpdatedAt(updatedAt, relativeTimeNow)}
      </span>
      <div
        className={cn(
          'absolute right-0 top-0 flex items-center gap-0.5 transition-opacity duration-100',
          forceVisible
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
        )}
      >
        <SafeTooltip content={pinned ? '取消置顶' : '置顶'} side="top">
          <button
            className={cn(
              'p-0.5 rounded transition-colors',
              pinned
                ? 'text-primary/60 hover:bg-foreground/[0.08] hover:text-primary'
                : 'text-foreground/30 hover:bg-foreground/[0.08] hover:text-foreground/60',
            )}
            onClick={onTogglePin}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        </SafeTooltip>
        <SafeTooltip
          content={archiveConfirming ? '再次点击确认归档' : archived ? '取消归档' : '归档'}
          side="top"
        >
          <button
            className={cn(
              'p-0.5 rounded transition-colors',
              archiveConfirming
                ? 'text-destructive bg-destructive/10'
                : archived
                  ? 'text-foreground/60 hover:bg-foreground/[0.08]'
                  : 'text-foreground/30 hover:bg-foreground/[0.08] hover:text-foreground/60',
            )}
            onClick={handleArchiveClick}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
        </SafeTooltip>
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'p-0.5 rounded text-foreground/30 hover:bg-foreground/[0.08] hover:text-foreground/60 transition-colors',
                'data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground/60',
              )}
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
            {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ===== 对话列表项 =====

interface ConversationItemProps {
  conversation: ConversationMeta
  active: boolean
  streaming: boolean
  /** 是否在标题旁显示 Pin 图标 */
  showPinIcon: boolean
  /** 输入框是否有未发送内容（草稿标记） */
  hasDraft?: boolean
  relativeTimeNow: number
  onSelect: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

export const ConversationItem = React.memo(function ConversationItem({
  conversation,
  active,
  streaming,
  showPinIcon,
  hasDraft,
  relativeTimeNow,
  onSelect,
  onRequestDelete,
  onRename,
  onTogglePin,
  onToggleArchive,
}: ConversationItemProps): React.ReactElement {
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const [menuOpen, setMenuOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)
  // 菜单打开时关闭迷你地图预览，避免预览面板盖住菜单项导致点不动
  const preview = useSessionMiniMapHover(600, menuOpen)

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(conversation.title)
    setEditing(true)
    justStartedEditing.current = true
    // 延迟聚焦，等待 ContextMenu 完全关闭后再 focus
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    // ContextMenu 关闭导致的 blur，忽略
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === conversation.title) {
      setEditing(false)
      return
    }
    await onRename(conversation.id, trimmed)
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const isPinned = !!conversation.pinned

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onTogglePin(conversation.id)}>
        {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        {isPinned ? '取消置顶' : '置顶对话'}
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onToggleArchive(conversation.id)}>
        {conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {conversation.archived ? '取消归档' : '归档'}
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5 text-destructive" onSelect={() => onRequestDelete(conversation.id)}>
        <Trash2 size={14} />
        删除对话
      </MenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={preview.setAnchorRef}
          role="button"
          data-profer-navigation-item="session"
          data-profer-navigation-active={active ? 'true' : undefined}
          tabIndex={0}
          onClick={() => { if (preview.shouldSuppressClick()) return; onSelect(conversation.id, conversation.title) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelect(conversation.id, conversation.title)
            }
          }}
          onMouseEnter={preview.handleMouseEnter}
          onMouseLeave={preview.handleMouseLeave}
          onTouchStart={preview.handleTouchStart}
          onTouchMove={preview.handleTouchMove}
          onTouchEnd={preview.handleTouchEnd}
          onTouchCancel={preview.handleTouchCancel}
          onDoubleClick={(e) => {
            e.stopPropagation()
            startEdit()
          }}
          className={cn(
            'group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 titlebar-no-drag text-left',
            active && 'session-item-selected',
            streaming
              ? 'text-foreground font-medium hover:bg-foreground/[0.03]'
              : 'hover:bg-foreground/[0.03]',
            active && 'bg-foreground/[0.08]',
          )}
        >
          {(streaming || (isClassic && active)) && (
            <span
              className={cn(
                'absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none',
                streaming ? 'bg-blue-500 animate-pulse' : 'bg-primary',
              )}
              aria-hidden="true"
            />
          )}
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={saveTitle}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent text-[13px] leading-5 text-foreground border-b border-primary/50 outline-none px-0 py-0"
                maxLength={100}
              />
            ) : (
              <div className={cn(
                'truncate text-[13px] leading-[18px] flex items-center gap-1.5',
                active ? 'text-foreground' : 'text-foreground/80'
              )}>
                {/* 置顶标记 */}
                {showPinIcon && (
                  <Pin size={11} className="flex-shrink-0 text-primary/60" />
                )}
                <span className="truncate">{conversation.title}</span>
                {/* 草稿标记：输入框有未发送内容 */}
                {hasDraft && (
                  <Pencil size={11} className="flex-shrink-0 text-foreground/40" aria-label="输入框有未发送内容" />
                )}
              </div>
            )}
          </div>

          {/* 默认显示时间，hover 时显示操作按钮 */}
          {!editing && (
            <SessionItemActions
              updatedAt={conversation.updatedAt}
              relativeTimeNow={relativeTimeNow}
              pinned={isPinned}
              archived={!!conversation.archived}
              onTogglePin={() => onTogglePin(conversation.id)}
              onToggleArchive={() => onToggleArchive(conversation.id)}
              onMenuOpenChange={setMenuOpen}
              menuItems={menuItems}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 z-[9999] min-w-0 p-0.5">
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
      <SessionMiniMapPopover
        target={{
          type: 'chat',
          sessionId: conversation.id,
          title: conversation.title,
        }}
        anchorRef={preview.anchorRef}
        open={preview.isOpen}
        isLeaving={preview.isLeaving}
        onMouseEnter={preview.handlePanelMouseEnter}
        onMouseLeave={preview.handlePanelMouseLeave}
      />
    </ContextMenu>
  )
})

// ===== Agent 会话列表项 =====

/** 会话行左侧状态条的颜色 — 与 SessionIndicatorStatus 呼应 */
type SessionLeftAccent = 'orange' | 'blue' | 'green'
const SESSION_ACCENT_ROW_CLASS: Record<SessionLeftAccent, string> = {
  orange: 'bg-orange-500/[0.08] text-foreground font-medium',
  blue: 'text-foreground font-medium hover:bg-foreground/[0.03]',
  green: 'text-foreground font-medium hover:bg-foreground/[0.03]',
}

const SESSION_ACCENT_INDICATOR_CLASS: Record<SessionLeftAccent, string> = {
  orange: 'bg-orange-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
}

const DELEGATION_STATUS_ICON_CLASS: Record<SessionIndicatorStatus, string> = {
  idle: 'text-foreground/40',
  running: 'text-blue-500',
  blocked: 'text-orange-500',
  completed: 'text-green-500',
}

export function getSessionLeftAccent(status: SessionIndicatorStatus): SessionLeftAccent | undefined {
  if (status === 'blocked') return 'orange'
  if (status === 'running') return 'blue'
  if (status === 'completed') return 'green'
  return undefined
}

interface AgentSessionItemProps {
  session: AgentSessionMeta
  active: boolean
  indicatorStatus: SessionIndicatorStatus
  showPinIcon?: boolean
  /** 输入框是否有未发送内容（草稿标记） */
  hasDraft?: boolean
  /** 行左侧状态色块；未传则不显示 */
  leftAccent?: SessionLeftAccent
  delegationSummary?: {
    total: number
    completed: number
    expanded: boolean
    onToggle: () => void
  }
  /** 是否禁用悬浮 Mini 地图 */
  disableMiniMap?: boolean
  /** 项目名称 Badge（跨项目列表时显示） */
  workspaceName?: string
  /** 用同一个时间戳刷新相对时间，避免每行独立计时 */
  relativeTimeNow: number
  onSelect: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

export const AgentSessionItem = React.memo(function AgentSessionItem({
  session,
  active,
  indicatorStatus,
  showPinIcon,
  hasDraft,
  delegationSummary,
  leftAccent,
  disableMiniMap,
  workspaceName,
  relativeTimeNow,
  onSelect,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleArchive,
}: AgentSessionItemProps): React.ReactElement {
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  // 该会话是否有活动浏览器会话/标签（即使面板被用户收起也保留显示，便于从侧边栏识别哪个会话正在用浏览器）
  const browserStateMap = useAtomValue(browserStateMapAtom)
  const hasBrowser = browserStateMap.has(session.id)
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const [menuOpen, setMenuOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)
  // 菜单打开时关闭迷你地图预览，避免预览面板盖住菜单项导致点不动
  const preview = useSessionMiniMapHover(600, disableMiniMap || menuOpen)

  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    justStartedEditing.current = true
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const saveTitle = async (): Promise<void> => {
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }
    await onRename(session.id, trimmed)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const canMove = indicatorStatus === 'idle' || indicatorStatus === 'completed'

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onTogglePin(session.id)}>
        {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        {session.pinned ? '取消置顶' : '置顶会话'}
      </MenuItem>
      {canMove && (
        <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onRequestMove(session.id)}>
          <ArrowRightLeft size={14} />
          迁移到其他项目
        </MenuItem>
      )}
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onToggleArchive(session.id)}>
        {session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {session.archived ? '取消归档' : '归档'}
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5 text-destructive" onSelect={() => onRequestDelete(session.id)}>
        <Trash2 size={14} />
        删除会话
      </MenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={preview.setAnchorRef}
          role="button"
          data-profer-navigation-item="session"
          data-profer-navigation-active={active ? 'true' : undefined}
          tabIndex={0}
          onClick={() => { if (preview.shouldSuppressClick()) return; onSelect(session.id, session.title) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelect(session.id, session.title)
            }
          }}
          onMouseEnter={preview.handleMouseEnter}
          onMouseLeave={preview.handleMouseLeave}
          onTouchStart={preview.handleTouchStart}
          onTouchMove={preview.handleTouchMove}
          onTouchEnd={preview.handleTouchEnd}
          onTouchCancel={preview.handleTouchCancel}
          onDoubleClick={(e) => {
            e.stopPropagation()
            startEdit()
          }}
          className={cn(
            'group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 titlebar-no-drag text-left',
            active && 'agent-session-item-active',
            leftAccent
              ? SESSION_ACCENT_ROW_CLASS[leftAccent]
              : 'hover:bg-foreground/[0.03]',
            // 选中态背景：浅色叠加深色变深、深色叠加浅色变浅，自动适配主题。
            // orange accent 自带橙色底色，不再叠加，避免视觉过重。
            active && leftAccent !== 'orange' && 'bg-foreground/[0.08]',
          )}
        >
          {(leftAccent || (isClassic && active)) && (
            <span
              className={cn(
                'absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none',
                leftAccent ? SESSION_ACCENT_INDICATOR_CLASS[leftAccent] : 'bg-primary',
              )}
            />
          )}
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={saveTitle}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent text-[13px] leading-5 text-foreground border-b border-primary/50 outline-none px-0 py-0"
                maxLength={100}
              />
            ) : (
              <div className={cn(
                'truncate text-[13px] leading-[18px] flex items-center gap-1.5',
                active ? 'text-foreground' : 'text-foreground/80'
              )}>
                {showPinIcon && (
                  <Pin size={11} className="flex-shrink-0 text-primary/60" />
                )}
                {session.sourceAutomationId && !session.sourceDelegationId && (
                  <Clock size={11} className="flex-shrink-0 text-foreground/40" />
                )}
                {session.sourceDelegationId && (
                  <GitBranch size={11} className={cn('flex-shrink-0', DELEGATION_STATUS_ICON_CLASS[indicatorStatus])} />
                )}
                {/* 该会话有活动浏览器会话/标签：在会话行上标识，便于从侧边栏识别哪个会话在用浏览器 */}
                {hasBrowser && (
                  <Globe size={11} className="flex-shrink-0 text-foreground/40" aria-label="该会话正在使用浏览器" />
                )}
                <span className="truncate">{session.title}</span>
                {/* 草稿标记：输入框有未发送内容 */}
                {hasDraft && (
                  <Pencil size={11} className="flex-shrink-0 text-foreground/40" aria-label="输入框有未发送内容" />
                )}
                {workspaceName && (
                  <span className="flex-shrink-0 px-1.5 py-0 rounded-full bg-primary/10 text-[10px] leading-4 workspace-badge font-medium truncate max-w-[80px]">
                    {workspaceName}
                  </span>
                )}
                {delegationSummary && (
                  <button
                    type="button"
                    aria-label={`${delegationSummary.expanded ? '收起' : '展开'}子会话`}
                    onClick={(event) => {
                      event.stopPropagation()
                      delegationSummary.onToggle()
                    }}
                    className="flex-shrink-0 inline-flex items-center gap-0.5 text-[11px] leading-4 text-foreground/45 hover:text-foreground/65 transition-colors"
                  >
                    <ChevronRight
                      size={10}
                      className={cn(
                        'transition-transform duration-150',
                        delegationSummary.expanded && 'rotate-90',
                      )}
                    />
                    {delegationSummary.completed}/{delegationSummary.total} 子会话
                  </button>
                )}
              </div>
            )}
          </div>

          {!editing && (
            <SessionItemActions
              updatedAt={session.updatedAt}
              relativeTimeNow={relativeTimeNow}
              pinned={!!session.pinned}
              archived={!!session.archived}
              onTogglePin={() => onTogglePin(session.id)}
              onToggleArchive={() => onToggleArchive(session.id)}
              onMenuOpenChange={setMenuOpen}
              menuItems={menuItems}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 z-[9999] min-w-0 p-0.5">
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
      {!disableMiniMap && (
        <SessionMiniMapPopover
          target={{
            type: 'agent',
            sessionId: session.id,
            title: session.title,
            workspaceName,
          }}
          anchorRef={preview.anchorRef}
          open={preview.isOpen}
          isLeaving={preview.isLeaving}
          onMouseEnter={preview.handlePanelMouseEnter}
          onMouseLeave={preview.handlePanelMouseLeave}
        />
      )}
    </ContextMenu>
  )
})

interface DelegatedChildSessionItemProps {
  session: AgentSessionMeta
  activeSessionId: string | null
  agentIndicatorMap: Map<string, SessionIndicatorStatus>
  relativeTimeNow: number
  workspaceName?: string
  /** 输入框是否有未发送内容（草稿标记） */
  hasDraft?: boolean
  onSelect: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

export const DelegatedChildSessionItem = React.memo(function DelegatedChildSessionItem({
  session,
  activeSessionId,
  agentIndicatorMap,
  relativeTimeNow,
  workspaceName,
  hasDraft,
  onSelect,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleArchive,
}: DelegatedChildSessionItemProps): React.ReactElement {
  const status = getDelegatedChildStatus(session, agentIndicatorMap)

  return (
    <AgentSessionItem
      session={session}
      active={session.id === activeSessionId}
      indicatorStatus={status}
      hasDraft={hasDraft}
      relativeTimeNow={relativeTimeNow}
      workspaceName={workspaceName}
      onSelect={onSelect}
      onRequestDelete={onRequestDelete}
      onRequestMove={onRequestMove}
      onRename={onRename}
      onTogglePin={onTogglePin}
      onToggleArchive={onToggleArchive}
    />
  )
})

// ===== 项目分组历史 =====

interface AgentProjectGroupItemProps {
  group: AgentProjectGroup
  currentWorkspaceId: string | null
  expanded: boolean
  collapsed: boolean
  /** 用户已点击"显示更多"额外展开的会话数量（基于 collapsedSessions 之上累加） */
  extraCount: number
  activeSessionId: string | null
  agentIndicatorMap: Map<string, SessionIndicatorStatus>
  /** 输入框有内容的 Agent 会话 ID 集合（草稿标记） */
  agentDraftIds: Set<string>
  expandedDelegationParentIds: Set<string>
  relativeTimeNow: number
  dragging: boolean
  dropPosition: 'before' | 'after' | null
  onShowMore: (workspaceId: string) => void
  onCollapseExtra: (workspaceId: string) => void
  onSelectProject: (workspaceId: string) => void | Promise<void>
  onToggleProjectCollapse: (workspaceId: string) => void
  onNewSession: (workspaceId: string) => Promise<void>
  onDragStart: (e: React.DragEvent, workspaceId: string) => void
  onDragOver: (e: React.DragEvent, workspaceId: string) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, workspaceId: string) => void
  onDragEnd: () => void
  onConfigureProject: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, newName: string) => Promise<void>
  onRequestDeleteWorkspace: (workspaceId: string) => void
  canDeleteWorkspace: boolean
  onSelectSession: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
  onToggleDelegationParent: (id: string) => void
  /** 工作区最近一次切换的时间戳，用于短暂高亮 */
  workspaceSwitchTs?: number
}

export const AgentProjectGroupItem = React.memo(function AgentProjectGroupItem({
  group,
  currentWorkspaceId,
  workspaceSwitchTs = 0,
  expanded,
  collapsed,
  extraCount,
  activeSessionId,
  agentIndicatorMap,
  agentDraftIds,
  expandedDelegationParentIds,
  relativeTimeNow,
  dragging,
  dropPosition,
  onShowMore,
  onCollapseExtra,
  onSelectProject,
  onToggleProjectCollapse,
  onNewSession,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onConfigureProject,
  onRenameWorkspace,
  onRequestDeleteWorkspace,
  canDeleteWorkspace,
  onSelectSession,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleArchive,
  onToggleDelegationParent,
}: AgentProjectGroupItemProps): React.ReactElement {
  const isCurrent = group.workspace.id === currentWorkspaceId
  /** 最近 1.2 秒内切换到此工作区时，短暂高亮 */
  const justSwitchedTo = isCurrent && workspaceSwitchTs > 0 && Date.now() - workspaceSwitchTs < 1200
  const isTeamWorkspace = group.workspace.type === 'team'
  const renderWorkspaceIcon = (size: number, className: string) =>
    isTeamWorkspace
      ? <Cloud size={size} className={className} />
      : <FolderOpen size={size} className={className} />

  const [renamingWorkspace, setRenamingWorkspace] = React.useState(false)
  const [workspaceEditName, setWorkspaceEditName] = React.useState('')
  const workspaceEditRef = React.useRef<HTMLInputElement>(null)
  const justStartedRenamingRef = React.useRef(false)
  const projectClickTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => () => {
    if (projectClickTimerRef.current) clearTimeout(projectClickTimerRef.current)
  }, [])

  const handleStartWorkspaceRename = (): void => {
    setWorkspaceEditName(group.workspace.name)
    setRenamingWorkspace(true)
    justStartedRenamingRef.current = true
    setTimeout(() => {
      justStartedRenamingRef.current = false
      workspaceEditRef.current?.focus()
      workspaceEditRef.current?.select()
    }, 300)
  }

  const handleWorkspaceRenameCommit = async (): Promise<void> => {
    if (justStartedRenamingRef.current) return
    const trimmed = workspaceEditName.trim()
    if (!trimmed || trimmed === group.workspace.name) {
      setRenamingWorkspace(false)
      return
    }
    await onRenameWorkspace(group.workspace.id, trimmed)
    setRenamingWorkspace(false)
  }

  const handleWorkspaceRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      void handleWorkspaceRenameCommit()
    } else if (e.key === 'Escape') {
      setRenamingWorkspace(false)
    }
  }
  const recentCutoff = relativeTimeNow - PROJECT_SESSION_RECENT_WINDOW_MS
  // 折叠时：所有"活跃"会话（运行中 / 阻塞 / 未查看的已完成）必须展示，
  // 不受 PROJECT_SESSION_PREVIEW_LIMIT 与 3 天窗口限制；活跃部分内部按
  // blocked > running > completed 优先级排序（与 railRecentItems 对齐），
  // 同优先级保留 group.sessions 的 updatedAt 倒序。
  // 非活跃部分仍保留原"最近 3 天 + 至多 5 条"预览策略，作为额外补充展示。
  // 用户点击"显示更多"会在折叠基线之上每次再额外展开 PROJECT_SESSION_EXPAND_STEP 条。
  const treeItems = buildAgentSessionTrees(group.sessions)
  const activeSessions = treeItems
    .filter((item) => ACTIVE_SESSION_STATUSES.has(getSessionTreeStatus(item, agentIndicatorMap)))
    .slice()
    .sort((a, b) => {
      const delta = ACTIVE_SESSION_STATUS_PRIORITY[getSessionTreeStatus(a, agentIndicatorMap)]
        - ACTIVE_SESSION_STATUS_PRIORITY[getSessionTreeStatus(b, agentIndicatorMap)]
      if (delta !== 0) return delta
      return b.session.updatedAt - a.session.updatedAt
    })
  const activeIds = collectTreeSessionIds(activeSessions)
  const fillSessions = treeItems
    .filter((item) =>
      !activeIds.has(item.session.id)
      && item.session.updatedAt >= recentCutoff
    )
    .slice(0, PROJECT_SESSION_PREVIEW_LIMIT)
  // 先拼不含置顶项的可见列表（含 extraSessions），再判断选中会话是否已可见。
  const collapsedSessionsWithoutPinned = [...activeSessions, ...fillSessions]
  const collapsedIdsWithoutPinned = new Set(collapsedSessionsWithoutPinned.map((item) => item.session.id))
  const remainingSessions = treeItems.filter((item) => !collapsedIdsWithoutPinned.has(item.session.id))
  const extraSessions = remainingSessions.slice(0, extraCount)
  const sessionsWithoutPinned = [...collapsedSessionsWithoutPinned, ...extraSessions]
  const visibleIds = collectTreeSessionIds(sessionsWithoutPinned)
  // 仅当选中会话不在当前完整可见列表（含 extra 区）中时才置顶（如搜索结果打开旧会话），
  // 已可见则保持原位不强制置顶（#958）。
  const currentSession = activeSessionId && !visibleIds.has(activeSessionId)
    ? treeItems.find((item) => treeContainsSessionId(item, activeSessionId)) ?? null
    : null
  const pinnedCurrent = currentSession ? [currentSession] : []
  const sessions = pinnedCurrent.length > 0
    ? [...activeSessions, ...pinnedCurrent, ...fillSessions, ...extraSessions]
    : sessionsWithoutPinned
  const hiddenCount = Math.max(0, treeItems.length - sessions.length)

  return (
    <section
      onDragOver={(e) => onDragOver(e, group.workspace.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, group.workspace.id)}
      onDragEnd={onDragEnd}
      className={cn('relative py-0.5 rounded-md transition-opacity', dragging && 'opacity-45')}
    >
      {dropPosition === 'before' && (
        <div className="absolute -top-0.5 left-3 right-3 h-0.5 translate-x-[2px] rounded-full bg-primary z-10" />
      )}

      <div className="group/project relative flex translate-x-[2px] items-center">
        <span
          draggable
          onDragStart={(e) => onDragStart(e, group.workspace.id)}
          title="拖拽排序"
          className="absolute -left-0.5 top-1/2 z-10 flex size-[18px] -translate-y-1/2 cursor-grab items-center justify-center text-foreground/20 opacity-0 transition-opacity group-hover/project:opacity-100 active:cursor-grabbing"
          aria-hidden="true"
        >
          <GripVertical size={12} />
        </span>

        {renamingWorkspace ? (
          <div
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-1 pl-[9px] pr-1 py-1 rounded-md text-left titlebar-no-drag group-hover/project:pl-4 group-hover/project:pr-11',
              isCurrent
                ? 'agent-project-item-current text-foreground'
                : 'text-foreground/65',
            )}
          >
            {renderWorkspaceIcon(13, 'flex-shrink-0 text-foreground/40')}
            <input
              ref={workspaceEditRef}
              value={workspaceEditName}
              onChange={(e) => setWorkspaceEditName(e.target.value)}
              onKeyDown={handleWorkspaceRenameKeyDown}
              onBlur={() => void handleWorkspaceRenameCommit()}
              className="flex-1 min-w-0 bg-transparent text-[13px] font-medium text-foreground border-b border-primary/50 outline-none px-0.5 leading-[18px]"
              maxLength={50}
            />
          </div>
        ) : (
          <button
            type="button"
            data-profer-navigation-item="project"
            data-profer-navigation-active={isCurrent ? 'true' : undefined}
            aria-expanded={!collapsed}
            aria-controls={`project-sessions-${group.workspace.id}`}
            onClick={(e) => {
              e.stopPropagation()
              if (e.target instanceof Element && e.target.closest('[data-project-collapse]')) {
                onToggleProjectCollapse(group.workspace.id)
                return
              }
              if (projectClickTimerRef.current) clearTimeout(projectClickTimerRef.current)
              projectClickTimerRef.current = setTimeout(() => {
                projectClickTimerRef.current = null
                void onSelectProject(group.workspace.id)
              }, PROJECT_TITLE_DOUBLE_CLICK_DELAY_MS)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (projectClickTimerRef.current) {
                clearTimeout(projectClickTimerRef.current)
                projectClickTimerRef.current = null
              }
              onToggleProjectCollapse(group.workspace.id)
            }}
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-1 pl-[9px] pr-1 py-1 rounded-md text-left transition-[padding,color,background-color] titlebar-no-drag group-hover/project:pl-4 group-hover/project:pr-11 hover:bg-foreground/[0.025]',
              isCurrent
                ? 'agent-project-item-current text-foreground'
                : 'text-foreground/65 hover:text-foreground/88',
              justSwitchedTo && 'animate-workspace-highlight bg-primary/15 rounded-md',
            )}
          >
            {renderWorkspaceIcon(13, 'flex-shrink-0 text-foreground/40')}
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium leading-[18px]">
              {group.workspace.name}
            </span>
            <span
              data-project-collapse
              title={collapsed ? '展开项目会话' : '收起项目会话'}
              className="flex-shrink-0 text-foreground/30 transition-colors hover:text-foreground/70"
            >
              <ChevronRight
                size={12}
                className={cn(
                  'transition-transform duration-150',
                  collapsed ? '-rotate-90' : 'rotate-90',
                )}
              />
            </span>
          </button>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`在「${group.workspace.name}」中新建会话`}
              onClick={(e) => {
                e.stopPropagation()
                void onNewSession(group.workspace.id)
              }}
              className="absolute right-5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-foreground/30 opacity-0 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/65 group-hover/project:opacity-100 titlebar-no-drag"
            >
              <Plus size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">在此项目中新建会话</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="项目菜单"
              className="absolute right-0 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-foreground/30 opacity-0 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/60 group-hover/project:opacity-100 data-[state=open]:opacity-100 titlebar-no-drag"
            >
              <MoreHorizontal size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44 z-[9999] min-w-0 p-0.5">
            <DropdownMenuItem
              className="text-xs py-1 [&>svg]:size-3.5"
              onSelect={() => onSelectProject(group.workspace.id)}
            >
              {renderWorkspaceIcon(14, '')}
              设为当前项目
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs py-1 [&>svg]:size-3.5"
              onSelect={handleStartWorkspaceRename}
            >
              <Pencil size={14} />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs py-1 [&>svg]:size-3.5"
              onSelect={() => onConfigureProject(group.workspace.id)}
            >
              <Settings size={14} />
              配置 MCP 与 Skills
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-0.5" />
            <DropdownMenuItem
              disabled={!canDeleteWorkspace}
              className={cn(
                'text-xs py-1 [&>svg]:size-3.5',
                canDeleteWorkspace && 'text-destructive focus:text-destructive',
              )}
              onSelect={() => onRequestDeleteWorkspace(group.workspace.id)}
            >
              <Trash2 size={14} />
              删除项目
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div id={`project-sessions-${group.workspace.id}`} className="ml-4 mt-px">
        {!collapsed ? (
          treeItems.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {sessions.map((item) => {
                const childCount = item.childSessions.length
                const rowStatus = getSessionTreeStatus(item, agentIndicatorMap)
                const treeActive = treeContainsSessionId(item, activeSessionId)
                const activeChildVisible = item.childSessions.some((child) => child.id === activeSessionId)
                const expandedChildren = expandedDelegationParentIds.has(item.session.id) || activeChildVisible

                return (
                  <div key={item.session.id} className="flex flex-col gap-0.5">
                    <AgentSessionItem
                      session={item.session}
                      active={treeActive}
                      indicatorStatus={rowStatus}
                      showPinIcon={!!item.session.pinned}
                      hasDraft={agentDraftIds.has(item.session.id)}
                      delegationSummary={childCount > 0
                        ? {
                          total: childCount,
                          completed: countCompletedDelegatedChildren(item.childSessions),
                          expanded: expandedChildren,
                          onToggle: () => onToggleDelegationParent(item.session.id),
                        }
                        : undefined}
                      leftAccent={getSessionLeftAccent(rowStatus)}
                      relativeTimeNow={relativeTimeNow}
                      onSelect={onSelectSession}
                      onRequestDelete={onRequestDelete}
                      onRequestMove={onRequestMove}
                      onRename={onRename}
                      onTogglePin={onTogglePin}
                      onToggleArchive={onToggleArchive}
                    />

                    {childCount > 0 && expandedChildren && (
                      <div className="ml-3 border-l border-foreground/10 pl-2 flex flex-col gap-0.5">
                        {item.childSessions.map((childSession) => (
                          <DelegatedChildSessionItem
                            key={childSession.id}
                            session={childSession}
                            activeSessionId={activeSessionId}
                            agentIndicatorMap={agentIndicatorMap}
                            hasDraft={agentDraftIds.has(childSession.id)}
                            relativeTimeNow={relativeTimeNow}
                            onSelect={onSelectSession}
                            onRequestDelete={onRequestDelete}
                            onRequestMove={onRequestMove}
                            onRename={onRename}
                            onTogglePin={onTogglePin}
                            onToggleArchive={onToggleArchive}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => onShowMore(group.workspace.id)}
                  className="w-full text-left px-1.5 py-1 rounded-md text-[12px] text-foreground/35 hover:bg-foreground/[0.03] hover:text-foreground/60 transition-colors titlebar-no-drag"
                >
                  显示更多
                </button>
              )}

              {expanded && (
                <button
                  type="button"
                  onClick={() => onCollapseExtra(group.workspace.id)}
                  className="w-full text-left px-1.5 py-1 rounded-md text-[12px] text-foreground/35 hover:bg-foreground/[0.03] hover:text-foreground/60 transition-colors titlebar-no-drag"
                >
                  收起
                </button>
              )}
            </div>
          ) : (
            <div className="px-1.5 py-0.5 text-[12px] text-foreground/22 select-none">
              暂无会话
            </div>
          )
        ) : null}
      </div>
      {dropPosition === 'after' && (
        <div className="absolute -bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-primary z-10" />
      )}
    </section>
  )
})
