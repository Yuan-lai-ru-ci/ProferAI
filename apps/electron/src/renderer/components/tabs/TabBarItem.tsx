/**
 * TabBarItem — 单个标签页 UI
 *
 * 显示：标题 + 工作区标签 + 流式指示器 + 关闭按钮
 * 支持：点击聚焦、中键关闭、拖拽重排
 * hover 预览面板由父级 TabBar 统一管理状态
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { FileText, StickyNote, X, Clock, Pencil, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TabType, TabMinimapItem } from '@/atoms/tab-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { tabMinimapCacheAtom } from '@/atoms/tab-atoms'
import { TabPreviewPanel } from './TabPreviewPanel'

export interface TabBarItemProps {
  id: string
  type: TabType
  title: string
  workspaceName?: string
  /** 标签栏整体空间不足时隐藏工作区徽标，让位给会话标题 */
  hideWorkspaceName?: boolean
  isActive: boolean
  isStreaming: SessionIndicatorStatus
  /** 是否显示 hover 预览面板（由父级管理） */
  isHovered: boolean
  /** 预览面板是否正在退出动画 */
  isLeaving: boolean
  /** 该 Tab 正在被拖出 TabBar 转分屏（tear-off 触发瞬间） */
  isTearingOff?: boolean
  onActivate: () => void
  onClose: () => void
  onMiddleClick: () => void
  onDragStart: (e: React.PointerEvent) => void
  /** 该 Tab 对应的会话是否由定时任务创建 */
  isAutomation?: boolean
  /** 在顶部标签栏中重命名 Agent 会话 */
  onRename?: (title: string) => Promise<void>
  /** hover 进入 Tab */
  onHoverEnter: () => void
  /** hover 离开 Tab */
  onHoverLeave: () => void
  /** hover 进入面板（阻止关闭） */
  onPanelHoverEnter: () => void
  /** hover 离开面板 */
  onPanelHoverLeave: () => void
}

export function TabBarItem({
  id,
  type,
  title,
  workspaceName,
  hideWorkspaceName = false,
  isActive,
  isStreaming,
  isHovered,
  isLeaving,
  isTearingOff,
  onActivate,
  onClose,
  onMiddleClick,
  onDragStart,
  isAutomation,
  onRename,
  onHoverEnter,
  onHoverLeave,
  onPanelHoverEnter,
  onPanelHoverLeave,
}: TabBarItemProps): React.ReactElement {
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = React.useRef(false)
  const [isNarrow, setIsNarrow] = React.useState(false)
  const [editingTitle, setEditingTitle] = React.useState(false)
  const [draftTitle, setDraftTitle] = React.useState(title)
  const [savingTitle, setSavingTitle] = React.useState(false)
  const titleInputRef = React.useRef<HTMLInputElement>(null)
  const minimapCache = useAtomValue(tabMinimapCacheAtom)

  React.useEffect(() => {
    const el = buttonRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const width = entry.contentRect.width
      // 工作区徽标不依赖 hover；只有标签进入极窄状态时才隐藏，
      // 普通未选中标签的收缩主要由关闭按钮收回完成。
      setIsNarrow(width < 72)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleMouseDown = (e: React.MouseEvent): void => {
    // Scratch Pad 不可中键关闭
    if (type === 'scratch') return
    if (e.button === 1) {
      e.preventDefault()
      onMiddleClick()
    }
  }

  const handlePointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    pointerStartRef.current = { x: e.clientX, y: e.clientY }
    suppressClickRef.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
    onDragStart(e)
  }

  const handleClick = (e: React.MouseEvent): void => {
    if (suppressClickRef.current) {
      e.preventDefault()
      e.stopPropagation()
      suppressClickRef.current = false
      return
    }
    onActivate()
  }

  const handlePointerMove = (e: React.PointerEvent): void => {
    const start = pointerStartRef.current
    if (!start) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) {
      suppressClickRef.current = true
    }
  }

  const handlePointerUp = (e: React.PointerEvent): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    pointerStartRef.current = null
  }

  const handleCloseClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClose()
  }

  const startRename = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!onRename) return
    setDraftTitle(title)
    setEditingTitle(true)
    requestAnimationFrame(() => {
      const input = titleInputRef.current
      if (!input) return
      input.focus()
      // 不全选文本，方便直接续写；鼠标拖选与 Shift+方向键可局部编辑。
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }

  const finishRename = async (): Promise<void> => {
    const nextTitle = draftTitle.trim()
    if (!nextTitle || nextTitle === title || !onRename) {
      setEditingTitle(false)
      return
    }
    setSavingTitle(true)
    try {
      await onRename(nextTitle)
      setEditingTitle(false)
    } finally {
      setSavingTitle(false)
    }
  }

  const isScratch = type === 'scratch'
  const indicatorColor = isScratch
    ? undefined
    : isStreaming !== 'idle'
    ? isStreaming === 'completed'
      ? 'border-green-500'
      : isStreaming === 'blocked'
        ? 'border-orange-500'
        : 'border-blue-500'
    : undefined
  const previewItems = minimapCache.get(id) ?? []
  // 当前 active Tab 不显示预览面板
  const showPreview = isHovered && !isActive

  // Scratch Pad 是固定草稿入口
  if (isScratch) {
    return (
      <div
        className="relative flex-shrink-0 titlebar-no-drag"
        onMouseEnter={onHoverEnter}
        onMouseLeave={onHoverLeave}
      >
        <button
          ref={buttonRef}
          type="button"
          className={cn(
            'group relative flex items-center justify-center gap-1.5 min-w-[82px] px-3 h-[32px] rounded-lg overflow-hidden',
            'text-xs transition-colors select-none cursor-grab active:cursor-grabbing',
            'border border-transparent',
            isActive
              ? 'app-tab-active text-foreground shadow-sm'
              : 'app-tab-inactive text-muted-foreground hover:text-foreground',
          )}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <StickyNote className="size-3.5" />
          <span className="truncate">草稿</span>
        </button>
      </div>
    )
  }

  return (
    <div
      data-tab-id={id}
      className={cn(
        'relative max-w-[320px] flex-[0_1_auto] titlebar-no-drag transition-[min-width] duration-200 ease-out',
        isActive ? 'min-w-[132px]' : 'min-w-[116px] hover:min-w-[132px]',
      )}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <button
        ref={buttonRef}
        type="button"
        role="tab"
        aria-selected={isActive}
        className={cn(
          'group relative flex items-center gap-1.5 px-3 h-[32px] w-full rounded-lg overflow-hidden',
          'text-xs transition-colors select-none cursor-grab active:cursor-grabbing',
          'border border-transparent',
          isActive
            ? 'app-tab-active text-foreground shadow-sm'
            : 'app-tab-inactive text-muted-foreground hover:text-foreground',
          isTearingOff && 'ring-2 ring-primary/70 ring-offset-0 bg-primary/10',
        )}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {type === 'preview' && !isNarrow && (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )}

        {/* 标题（窄状态下隐藏，用 spacer 撑开让关闭按钮靠右） */}
        {isNarrow ? (
          <span className="flex-1" />
        ) : (
          <span className="flex flex-1 min-w-0 items-center gap-1 text-left">
            {isAutomation && <Clock className="size-3 shrink-0 text-foreground/40" />}
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={draftTitle}
                maxLength={100}
                disabled={savingTitle}
                aria-label="会话标题"
                className="h-5 min-w-0 flex-1 border-b border-primary/60 bg-transparent px-0 text-xs outline-none"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => void finishRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void finishRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditingTitle(false)
                  }
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            )}
            {onRename && !editingTitle && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="重命名会话"
                className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-60 transition-opacity hover:bg-muted-foreground/20 hover:opacity-100"
                onClick={startRename}
              >
                <Pencil className="size-2.5" />
              </span>
            )}
            {editingTitle && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="保存会话标题"
                className="flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted-foreground/20"
                onClick={(event) => { event.stopPropagation(); void finishRename() }}
              >
                <Check className="size-2.5" />
              </span>
            )}
          </span>
        )}

        {workspaceName && !hideWorkspaceName && !isNarrow && (
          <span className="shrink-0 px-1.5 py-0 rounded-full bg-primary/10 text-[10px] leading-4 workspace-badge font-medium truncate max-w-[86px]">
            {workspaceName}
          </span>
        )}

        {/* 关闭按钮（scratch 类型不显示） */}
        {!isScratch && (
        <span
          role="button"
          tabIndex={-1}
          className={cn(
            'h-4 shrink-0 rounded-sm flex items-center justify-center overflow-hidden',
            isActive
              ? 'w-4 opacity-60'
              : 'w-0 opacity-0 group-hover:w-4 group-hover:opacity-100',
            'hover:bg-muted-foreground/20 transition-[width,opacity]',
          )}
          // 阻止标签按钮把关闭操作误判为拖拽开始；否则父级会 setPointerCapture，
          // 鼠标松开时关闭点击可能被拖拽流程吞掉。中键关闭不受影响。
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleCloseClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleCloseClick(e as unknown as React.MouseEvent)
          }}
        >
          <X className="size-2.5" />
        </span>
        )}

        {/* 状态包边 */}
        {indicatorColor && (
          <span
            className={cn(
              'absolute inset-0 border-t-2 border-l-2 border-r-2 border-b-0 pointer-events-none',
              'rounded-lg',
              indicatorColor,
            )}
            aria-hidden="true"
          />
        )}
      </button>

      {/* 悬浮预览面板（Portal 渲染到 body） */}
      {showPreview && (
        <TabPreviewDropdown
          buttonRef={buttonRef}
          title={title}
          items={previewItems}
          isLeaving={isLeaving}
          onMouseEnter={onPanelHoverEnter}
          onMouseLeave={onPanelHoverLeave}
        />
      )}
    </div>
  )
}

/** 使用 Portal 渲染到 body，避免被容器 overflow 裁剪或被内容区遮盖 */
function TabPreviewDropdown({
  buttonRef,
  title,
  items,
  isLeaving,
  onMouseEnter,
  onMouseLeave,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  title: string
  items: TabMinimapItem[]
  isLeaving: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}): React.ReactElement | null {
  const panelWidth = 280
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)

  React.useLayoutEffect(() => {
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const top = rect.bottom
    let left = rect.left
    if (left + panelWidth > viewportWidth - 8) {
      left = viewportWidth - panelWidth - 8
    }
    if (left < 8) {
      left = 8
    }
    setPos({ top, left })
  }, [buttonRef])

  if (!pos) return null

  return createPortal(
    <div
      className="fixed z-[9999] pt-1"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <TabPreviewPanel title={title} items={items} isLeaving={isLeaving} />
    </div>,
    document.body
  )
}
