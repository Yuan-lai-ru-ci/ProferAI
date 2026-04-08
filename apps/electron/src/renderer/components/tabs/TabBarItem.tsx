/**
 * TabBarItem — 单个标签页 UI
 *
 * 显示：类型图标 + 标题 + 流式指示器 + 关闭按钮
 * 支持：点击聚焦、中键关闭、拖拽重排
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { MessageSquare, Bot, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TabType, TabMinimapItem } from '@/atoms/tab-atoms'
import { tabMinimapCacheAtom } from '@/atoms/tab-atoms'
import { TabPreviewPanel } from './TabPreviewPanel'

export interface TabBarItemProps {
  id: string
  type: TabType
  title: string
  isActive: boolean
  isStreaming: boolean
  onActivate: () => void
  onClose: () => void
  onMiddleClick: () => void
  /** 拖拽相关 */
  onDragStart: (e: React.PointerEvent) => void
}

export function TabBarItem({
  id,
  type,
  title,
  isActive,
  isStreaming,
  onActivate,
  onClose,
  onMiddleClick,
  onDragStart,
}: TabBarItemProps): React.ReactElement {
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const [isNarrow, setIsNarrow] = React.useState(false)
  const minimapCache = useAtomValue(tabMinimapCacheAtom)

  // hover 预览面板状态
  const [hovered, setHovered] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const enterTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()

  React.useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  const handleMouseEnter = (): void => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
    // 延迟 300ms 后显示，避免快速划过时闪烁
    enterTimerRef.current = setTimeout(() => setHovered(true), 300)
  }

  const handleMouseLeave = (): void => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    leaveTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setHovered(false)
        setIsLeaving(false)
      }, 80)
    }, 40)
  }

  React.useEffect(() => {
    const el = buttonRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setIsNarrow(entry.contentRect.width < 72)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleMouseDown = (e: React.MouseEvent): void => {
    // 中键点击关闭
    if (e.button === 1) {
      e.preventDefault()
      onMiddleClick()
    }
  }

  const handleCloseClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClose()
  }

  const Icon = type === 'chat' ? MessageSquare : Bot
  const previewItems = minimapCache.get(id) ?? []

  return (
    <div
      className="relative flex-1 min-w-[48px] max-w-[200px]"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          'group relative flex items-center gap-1.5 px-3 h-[34px] w-full',
          'rounded-t-lg text-xs transition-colors select-none cursor-pointer',
          'border-t border-l border-r border-transparent',
          isActive
            ? 'bg-content-area text-foreground border-border/50'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        )}
        onClick={onActivate}
        onMouseDown={handleMouseDown}
        onPointerDown={onDragStart}
      >
        {/* 类型图标（窄状态下放大） */}
        <Icon className={cn('shrink-0', isNarrow ? 'size-3.5' : 'size-3')} />

        {/* 标题（窄状态下隐藏，用 spacer 撑开让关闭按钮靠右） */}
        {isNarrow ? (
          <span className="flex-1" />
        ) : (
          <span className="flex-1 min-w-0 truncate text-left">{title}</span>
        )}

        {/* 流式指示器（窄状态下隐藏） */}
        {isStreaming && !isNarrow && (
          <span
            className={cn(
              'size-1.5 rounded-full shrink-0 animate-pulse',
              type === 'chat' ? 'bg-emerald-500' : 'bg-blue-500'
            )}
          />
        )}

        {/* 关闭按钮 */}
        <span
          role="button"
          tabIndex={-1}
          className={cn(
            'size-4 rounded-sm flex items-center justify-center shrink-0',
            'opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 transition-opacity',
            isActive && 'opacity-60',
          )}
          onClick={handleCloseClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleCloseClick(e as unknown as React.MouseEvent)
          }}
        >
          <X className="size-2.5" />
        </span>
      </button>

      {/* 悬浮预览面板（Portal 渲染到 body） */}
      {hovered && (
        <TabPreviewDropdown
          buttonRef={buttonRef}
          title={title}
          items={previewItems}
          isLeaving={isLeaving}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
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
    // 面板顶部紧贴 Tab 底部
    const top = rect.bottom + 4
    // 默认左对齐 Tab
    let left = rect.left
    // 右侧溢出
    if (left + panelWidth > viewportWidth - 8) {
      left = viewportWidth - panelWidth - 8
    }
    // 左侧溢出
    if (left < 8) {
      left = 8
    }
    setPos({ top, left })
  }, [buttonRef])

  if (!pos) return null

  return createPortal(
    <div
      className="fixed z-[9999]"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <TabPreviewPanel title={title} items={items} isLeaving={isLeaving} />
    </div>,
    document.body
  )
}
