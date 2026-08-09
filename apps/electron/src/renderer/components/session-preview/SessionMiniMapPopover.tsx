/**
 * SessionMiniMapPopover — 左侧会话悬浮迷你地图
 *
 * 用于在 Working、置顶、最近会话和折叠侧栏中快速扫读会话结构。
 * 优先复用已打开会话写入的 tabMinimapCache；未打开时按需读取本地 JSONL。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue } from 'jotai'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Bot, Loader2, MessageSquare } from 'lucide-react'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { tabMinimapCacheAtom, type TabMinimapItem } from '@/atoms/tab-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { cn } from '@/lib/utils'
import type {
  ChatMessage,
  SDKMessage,
} from '@profer/shared'
import {
  getGroupId,
  getGroupPreview,
  groupIntoTurns,
  type MessageGroup,
} from '@/components/agent/SDKMessageRenderer'

export type SessionMiniMapType = 'chat' | 'agent'

export interface SessionMiniMapTarget {
  type: SessionMiniMapType
  sessionId: string
  title: string
  workspaceName?: string
}

interface UseSessionMiniMapHoverReturn {
  anchorRef: React.MutableRefObject<HTMLElement | null>
  setAnchorRef: (node: HTMLElement | null) => void
  isOpen: boolean
  isLeaving: boolean
  handleMouseEnter: () => void
  handleMouseLeave: () => void
  handlePanelMouseEnter: () => void
  handlePanelMouseLeave: () => void
  // ---- 触屏长按预览（轻触不触发；长按后抬起保持预览，并拦截随后的 click 避免误打开会话） ----
  handleTouchStart: (e: React.TouchEvent) => void
  handleTouchMove: (e: React.TouchEvent) => void
  handleTouchEnd: () => void
  handleTouchCancel: () => void
  /** 消费“长按已触发”标记：列表项 onClick 中调用，长按后返回 true（应跳过打开会话） */
  shouldSuppressClick: () => boolean
}

/** 触屏上点击列表项时浏览器会合成 mouseenter，导致预览误弹出；纯触屏（无精确悬停）只允许长按触发 */
const TOUCH_ONLY_MEDIA = '(hover: none)'
/** 长按后手指位移超过该阈值视为滚动/取消 */
const TOUCH_MOVE_TOLERANCE = 12

const isTouchOnly = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.(TOUCH_ONLY_MEDIA)?.matches === true

interface SessionMiniMapPopoverProps {
  target: SessionMiniMapTarget
  anchorRef: React.MutableRefObject<HTMLElement | null>
  open: boolean
  isLeaving: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}

const PANEL_WIDTH = 318
const PANEL_MIN_HEIGHT = 132
const PANEL_MAX_HEIGHT = 420
const PANEL_GAP = 16
const VIEWPORT_MARGIN = 8
const MAX_RENDERED_ITEMS = 80
const PREVIEW_REMARK_PLUGINS = [remarkGfm]

const PREVIEW_MD_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-0">{children}</p>,
  ul: ({ children }) => <ul className="my-0 pl-3">{children}</ul>,
  ol: ({ children }) => <ol className="my-0 pl-3">{children}</ol>,
  li: ({ children }) => <li className="my-0">{children}</li>,
  pre: ({ children }) => <pre className="my-0 truncate text-[11px] opacity-70">{children}</pre>,
  code: ({ children }) => <code className="rounded bg-muted/50 px-0.5 text-[11px]">{children}</code>,
  img: () => null,
  a: ({ children }) => <span>{children}</span>,
}

export function useSessionMiniMapHover(delayMs = 600, disabled = false): UseSessionMiniMapHoverReturn {
  const anchorRef = React.useRef<HTMLElement | null>(null)
  const [isOpen, setIsOpen] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const enterTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()

  // ---- 触屏长按状态 ----
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const longPressTriggeredRef = React.useRef(false)
  const suppressClickRef = React.useRef(false)
  const touchStartPointRef = React.useRef<{ x: number; y: number } | null>(null)
  const touchOnlyRef = React.useRef(isTouchOnly())
  /** 长按打开预览后挂的“触摸外部关闭”监听清理器 */
  const outsideCloseCleanupRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
      outsideCloseCleanupRef.current?.()
      outsideCloseCleanupRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!disabled) return
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    setIsOpen(false)
    setIsLeaving(false)
  }, [disabled])

  const setAnchorRef = React.useCallback((node: HTMLElement | null): void => {
    anchorRef.current = node
  }, [])

  // 触屏上忽略合成 mouseenter（纯触屏只能长按触发预览，避免轻触/滑动时预览误弹出）
  const handleMouseEnter = React.useCallback((): void => {
    if (disabled) return
    if (touchOnlyRef.current) return
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
    if (isOpen) return
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    enterTimerRef.current = setTimeout(() => setIsOpen(true), delayMs)
  }, [delayMs, disabled, isOpen])

  const closeWithDelay = React.useCallback((): void => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    leaveTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setIsOpen(false)
        setIsLeaving(false)
      }, 90)
    }, 160)
  }, [])

  const handlePanelMouseEnter = React.useCallback((): void => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
  }, [])

  // ---- 触屏长按 ----

  /** 长按已触发后保持预览打开；触摸面板外任意位置时关闭（面板自身 touch stopPropagation 保护）。
   *  用 bubble 阶段监听：面板内的 onTouchStart stopPropagation 能拦下，触摸面板内容不会误关。 */
  const armOutsideClose = React.useCallback((): void => {
    outsideCloseCleanupRef.current?.()
    let timer: ReturnType<typeof setTimeout> | undefined
    const onOutsideTouch = (): void => {
      cleanup()
      setIsOpen(false)
      setIsLeaving(false)
    }
    const cleanup = (): void => {
      window.removeEventListener('touchstart', onOutsideTouch)
      if (timer) clearTimeout(timer)
    }
    // 延迟一帧再挂监听：当前 touchstart 的冒泡已结束，不会立刻把刚打开的预览关掉
    timer = setTimeout(() => {
      window.addEventListener('touchstart', onOutsideTouch)
    }, 0)
    outsideCloseCleanupRef.current = cleanup
  }, [])

  const handleTouchStart = React.useCallback((e: React.TouchEvent): void => {
    if (disabled) return
    // 触摸任意列表项：若已有预览打开，先关闭（新的长按 600ms 后才打开新预览）
    if (isOpen) {
      setIsOpen(false)
      setIsLeaving(false)
    }
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    const touch = e.touches[0]
    if (!touch) return
    touchStartPointRef.current = { x: touch.clientX, y: touch.clientY }
    longPressTriggeredRef.current = false
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true
      setIsLeaving(false)
      setIsOpen(true)
      armOutsideClose()
    }, delayMs)
  }, [disabled, delayMs, isOpen, armOutsideClose])

  const handleTouchMove = React.useCallback((e: React.TouchEvent): void => {
    // 长按未触发时位移超阈值视为滚动，取消长按；长按已触发（预览已开）时位移也视为取消（手指滑动离开）
    const start = touchStartPointRef.current
    if (!start) return
    const touch = e.touches[0]
    if (!touch) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (Math.hypot(dx, dy) > TOUCH_MOVE_TOLERANCE) {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
      touchStartPointRef.current = null
      if (longPressTriggeredRef.current) {
        longPressTriggeredRef.current = false
        setIsOpen(false)
        setIsLeaving(false)
      }
    }
  }, [])

  const handleTouchEnd = React.useCallback((): void => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    touchStartPointRef.current = null
    // 长按已触发：预览保持打开，并拦截随后的合成 click（避免误打开会话）
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false
      suppressClickRef.current = true
    }
  }, [])

  const handleTouchCancel = React.useCallback((): void => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    touchStartPointRef.current = null
    longPressTriggeredRef.current = false
    suppressClickRef.current = false
  }, [])

  /** 消费“长按已触发”标记；返回 true 表示应跳过本次 click 的默认行为 */
  const shouldSuppressClick = React.useCallback((): boolean => {
    const suppress = suppressClickRef.current
    suppressClickRef.current = false
    return suppress
  }, [])

  return {
    anchorRef,
    setAnchorRef,
    isOpen,
    isLeaving,
    handleMouseEnter,
    handleMouseLeave: closeWithDelay,
    handlePanelMouseEnter,
    handlePanelMouseLeave: closeWithDelay,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    shouldSuppressClick,
  }
}

function normalizePreviewText(text: string): string {
  return text
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\n*/g, '')
    .replace(/<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildChatMinimapItems(messages: ChatMessage[], userAvatar?: string): TabMinimapItem[] {
  return messages
    .map((message) => ({
      id: message.id,
      role: message.role === 'user' ? 'user' as const : message.role === 'assistant' ? 'assistant' as const : 'status' as const,
      preview: normalizePreviewText(message.content).slice(0, 220),
      avatar: message.role === 'user' ? userAvatar : undefined,
      model: message.model,
    }))
    .filter((item) => item.preview.length > 0)
}

function buildAgentMinimapItems(messages: SDKMessage[], userAvatar?: string): TabMinimapItem[] {
  // 必须与 AgentMessages 使用同一套 turn 分组逻辑：tool_result 是工具链内部消息，
  // 不能在预览中作为“工具返回结果”单独占一行。
  const groups = groupIntoTurns(messages)
  return groups
    .map((group: MessageGroup): TabMinimapItem => {
      const preview = normalizePreviewText(getGroupPreview(group)).slice(0, 220)
      return {
        id: getGroupId(group),
        role: group.type === 'user' ? 'user' : group.type === 'system' ? 'status' : 'assistant',
        preview,
        avatar: group.type === 'user' ? userAvatar : undefined,
        model: group.type === 'assistant-turn' ? group.model : undefined,
      }
    })
    .filter((item) => item.preview.length > 0)
}

function usePopoverPosition(
  anchorRef: React.MutableRefObject<HTMLElement | null>,
  open: boolean,
  preferredHeight: number,
): { top: number; left: number; height: number } | null {
  const [position, setPosition] = React.useState<{ top: number; left: number; height: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const update = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const availableHeight = Math.max(120, viewportHeight - VIEWPORT_MARGIN * 2)
      const height = Math.min(preferredHeight, availableHeight)
      let left = rect.right + PANEL_GAP
      if (left + PANEL_WIDTH > viewportWidth - VIEWPORT_MARGIN) {
        left = rect.left - PANEL_WIDTH - PANEL_GAP
      }
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN

      const preferredTop = rect.top + rect.height / 2 - height / 2
      const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN)
      const top = Math.min(Math.max(VIEWPORT_MARGIN, preferredTop), maxTop)
      setPosition({ top, left, height })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, open, preferredHeight])

  return position
}

function getPreferredPanelHeight({
  loading,
  error,
  itemCount,
}: {
  loading: boolean
  error: string | null
  itemCount: number
}): number {
  if (loading) return 260
  if (error || itemCount === 0) return PANEL_MIN_HEIGHT
  const visibleItems = Math.min(itemCount, 8)
  return Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, 54 + visibleItems * 42))
}

function getMessageBubbleClass(item: TabMinimapItem): string {
  if (item.role === 'user') return 'bg-primary/[0.06]'
  if (item.role === 'status') return 'bg-amber-500/[0.08]'
  return ''
}

function PreviewText({ text }: { text: string }): React.ReactElement {
  if (!text) {
    return <span className="text-[11px] text-muted-foreground/60">(空消息)</span>
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] leading-4 text-popover-foreground/72 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 prose-pre:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-2 overflow-hidden">
      <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

function ItemIcon({ item, type }: { item: TabMinimapItem; type: SessionMiniMapType }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if (item.role === 'assistant' && item.model) {
    return (
      <img
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'assistant') {
    return <Bot className="size-4 shrink-0 mt-0.5 text-blue-500/70" />
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-muted-foreground/60" />
  }
  return type === 'chat'
    ? <MessageSquare className="size-4 shrink-0 mt-0.5 text-muted-foreground/60" />
    : <Bot className="size-4 shrink-0 mt-0.5 text-muted-foreground/60" />
}

export function SessionMiniMapPopover(props: SessionMiniMapPopoverProps): React.ReactElement | null {
  if (!props.open) return null
  return <SessionMiniMapPopoverContent {...props} />
}

function SessionMiniMapPopoverContent({
  target,
  anchorRef,
  open,
  isLeaving,
  onMouseEnter,
  onMouseLeave,
}: SessionMiniMapPopoverProps): React.ReactElement | null {
  const userProfile = useAtomValue(userProfileAtom)
  const [cache, setCache] = useAtom(tabMinimapCacheAtom)
  const cachedItems = cache.get(target.sessionId)
  const [items, setItems] = React.useState<TabMinimapItem[]>(cachedItems ?? [])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const preferredHeight = getPreferredPanelHeight({ loading, error, itemCount: items.length })
  const position = usePopoverPosition(anchorRef, open, preferredHeight)
  const renderedItems = React.useMemo(
    () => items.length > MAX_RENDERED_ITEMS ? items.slice(-MAX_RENDERED_ITEMS) : items,
    [items],
  )

  React.useEffect(() => {
    if (!open) return
    if (cachedItems) {
      setItems(cachedItems)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])

    const load = async (): Promise<void> => {
      try {
        const nextItems = target.type === 'chat'
          ? buildChatMinimapItems(await window.electronAPI.getConversationMessages(target.sessionId), userProfile.avatar)
          : buildAgentMinimapItems(await window.electronAPI.getAgentSessionSDKMessages(target.sessionId), userProfile.avatar)
        if (cancelled) return
        setItems(nextItems)
        setCache((prev) => {
          const next = new Map(prev)
          next.set(target.sessionId, nextItems)
          return next
        })
      } catch (loadError) {
        console.error('[会话迷你地图] 加载失败:', loadError)
        if (!cancelled) setError('无法加载会话内容')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [cachedItems, open, setCache, target.sessionId, target.type, userProfile.avatar])

  if (!open || !position) return null

  return createPortal(
    <div
      className="fixed z-[9999] titlebar-no-drag transition-[top,height] duration-150 ease-out pointer-events-auto"
      style={{ top: position.top, left: position.left, width: PANEL_WIDTH, height: position.height }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // 触屏长按预览：面板内触摸不冒泡到 window，避免“外部触摸关闭”把正在查看的预览关掉
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'session-minimap-popover h-full rounded-xl bg-popover shadow-xl ring-1 ring-black/[0.05] dark:ring-white/[0.08] flex flex-col overflow-hidden',
          isLeaving ? 'session-minimap-popover-exit' : 'session-minimap-popover-enter',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 shrink-0 bg-muted/35 border-b border-border/35">
          <div className="min-w-0 flex items-center gap-2">
            <span className="truncate text-xs font-medium text-popover-foreground/85">
              {target.title}
            </span>
            {target.workspaceName && (
              <span className="shrink-0 px-1.5 py-0 rounded-full bg-primary/10 text-[10px] leading-4 workspace-badge font-medium truncate max-w-[92px]">
                {target.workspaceName}
              </span>
            )}
          </div>
          <span className="w-[44px] shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {loading ? '加载中' : `${items.length} 条`}
          </span>
        </div>

        <div className="relative flex-1 min-h-0 overflow-hidden bg-popover p-1.5">
          {loading && (
            <div className="absolute inset-1.5 rounded-md bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                <span>正在读取会话...</span>
              </div>
              <div className="mt-4 space-y-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <div className="mt-0.5 size-4 rounded bg-muted/70 animate-pulse" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-2.5 w-full rounded bg-muted/70 animate-pulse" />
                      <div className="h-2.5 w-2/3 rounded bg-muted/50 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="h-full rounded-md bg-muted/30 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">{error}</div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="h-full rounded-md bg-muted/30 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">暂无可预览内容</div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="h-full overflow-y-auto space-y-1 scrollbar-thin session-minimap-content-enter">
              {renderedItems.map((item, index) => (
                <div
                  key={`${item.id}-${index}`}
                  className="flex items-start gap-2 w-full px-2 py-1 text-left"
                >
                  <ItemIcon item={item} type={target.type} />
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        'w-fit max-w-full rounded-md py-1',
                        item.role === 'assistant' ? 'px-0' : 'px-2',
                        getMessageBubbleClass(item),
                      )}
                    >
                      <PreviewText text={item.preview} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
