/**
 * ScrollMinimap — 消息导航迷你地图 + 滚动进度条
 *
 * 在消息区域左侧显示：
 * 1. 短横杠代表**一轮对话**（用户提问 + 助手回复）的位置（迷你地图），悬浮时弹出该轮预览
 * 2. 右侧可拖拽的滚动进度条
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { MarkdownPreview, MARKDOWN_PREVIEW_LIGHT_COMPONENTS } from '@profer/ui'
import { AlertTriangle, Search } from 'lucide-react'
import { useConversationScroll } from './conversation-scroll'
import { attachScrollbarReveal } from './scrollbar-reveal'
import { Input } from '@profer/ui/primitives/input'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/utils'
import { groupNavigationTurns, type NavigationTurn } from '@/lib/navigation-turns'

export interface MinimapItem {
  /** 滚动锚点 id（消息 uuid）；无 uuid 时为 null，需用 matchKey 在本地 DOM 里回退匹配 */
  id: string | null
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
  /**
   * 无 id 时的稳定匹配键（`${role}:${subtype}:${createdAt}`）。
   * 导航索引覆盖全会话，而后行不在 DOM 里；有 id 的行用 id，无 id 的行用它扫已加载的
   * `data-message-nav-key` 节点。两者皆无才标为“未加载”。
   */
  matchKey?: string
}

interface ScrollMinimapProps {
  items: MinimapItem[]
  /**
   * 拉取更早一页消息（命中不了旧条目时调用）。不传则不提供“加载更早”入口。
   */
  onRequestEarlier?: () => void
}

/** 最少轮数才显示迷你地图 */
const MIN_ITEMS = 1
/** 迷你地图最多渲染的横杠数 */
const MAX_BARS = 20
/**
 * 面板列表最多渲染的行数。
 *
 * 导航总数覆盖全会话（可达成百上千轮），但面板开启时每次滚动都会重算可见项并重渲染列表，
 * 全量渲染（含 markdown 预览）会拖慢滚动。历史区段本来就要先「加载更早消息」才能跳，
 * 这里只渲染最近的 N 行，总数仍显示真实值（不随窗口/折叠/截断变化）。
 */
const MAX_LIST_ITEMS = 200
/** 横杠静止宽度（px） */
const REST_WIDTH = 6
/** 被悬停那根的宽度（px） */
const PEAK_WIDTH = 22
/**
 * 悬停时的邻域衰减：下标 = 与指针所在刻度的距离，值 = 伸长比例。
 * 自己吃满，上下邻条依次减弱，形成一道跟着指针走的起伏，而不是孤零零一根长杠。
 */
const WAVE_FALLOFF = [1, 0.45, 0.22] as const

// ── 辅助函数 ──

/**
 * 在已渲染的 DOM 里找导航条目对应的节点。
 * 有 uuid 的用 data-message-id；无 uuid 的（interruption_record 等）用 data-message-nav-key。
 */
function findMessageNode(el: HTMLElement, id: string | null, matchKey?: string): HTMLElement | null {
  if (id) {
    const byId = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === id
    )
    if (byId) return byId
  }
  if (matchKey) {
    return Array.from(el.querySelectorAll<HTMLElement>('[data-message-nav-key]')).find(
      (node) => node.getAttribute('data-message-nav-key') === matchKey
    ) ?? null
  }
  return null
}

/** 节点是否与主区视口相交（与 visibleIds 的几何判定同一口径）。 */
function isNodeInViewport(
  node: HTMLElement,
  container: HTMLElement,
  scrollTop: number,
  clientHeight: number,
): boolean {
  const top = getOffsetTopRelativeTo(node, container)
  const bottom = top + node.offsetHeight
  return bottom > scrollTop && top < scrollTop + clientHeight
}

/** 计算 node 相对于 container 的实际顶部偏移（递归累积 offsetTop） */
function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = node
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

/** 转义正则特殊字符 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface MinimapViewportState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  ids: Set<string>
  keys: Set<string>
  centerId?: string
}

function sameIds(previous: Set<string>, next: Set<string>): boolean {
  return previous.size === next.size && [...next].every(id => previous.has(id))
}

/** 同一帧只测量一次；相同几何与高亮不提交 React 状态。 */
export function observeMinimapViewport(
  el: HTMLElement,
  content: HTMLElement | null,
  changed: (state: MinimapViewportState) => void,
): () => void {
  let frame: number | null = null
  let previous: MinimapViewportState | undefined
  const update = (): void => {
    frame = null
    const { scrollTop, scrollHeight, clientHeight } = el
    const ids = new Set<string>()
    const keys = new Set<string>()
    const center = scrollTop + clientHeight / 2
    let centerId: string | undefined
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-id], [data-message-nav-key]')) {
      const top = getOffsetTopRelativeTo(node, el)
      const bottom = top + node.offsetHeight
      const id = node.getAttribute('data-message-id')
      const key = node.getAttribute('data-message-nav-key')
      if (bottom > scrollTop && top < scrollTop + clientHeight) {
        if (id) ids.add(id)
        if (key) keys.add(key)
      }
      if (centerId === undefined && id && top <= center && bottom > center) centerId = id
    }
    if (previous && previous.scrollTop === scrollTop && previous.scrollHeight === scrollHeight
      && previous.clientHeight === clientHeight && previous.centerId === centerId
      && sameIds(previous.ids, ids) && sameIds(previous.keys, keys)) return
    const state = {
      scrollTop, scrollHeight, clientHeight, centerId,
      ids: previous && sameIds(previous.ids, ids) ? previous.ids : ids,
      keys: previous && sameIds(previous.keys, keys) ? previous.keys : keys,
    }
    previous = state
    changed(state)
  }
  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(update)
  }
  schedule()
  el.addEventListener('scroll', schedule, { passive: true })
  const observer = new ResizeObserver(schedule)
  observer.observe(el)
  if (content) observer.observe(content)
  return () => {
    el.removeEventListener('scroll', schedule)
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
  }
}

// ── 主组件 ──

export function ScrollMinimap({ items, onRequestEarlier }: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef, contentRef, pause, navigate, beginLayout } = useConversationScroll()
  /** 面板是否打开 —— 只由「右键轨道」或 ⌘F 打开，不再由悬停触发 */
  const [panelOpen, setPanelOpen] = React.useState(false)
  /** 当前悬停的横杠下标（该横杠代表的一轮预览）；null = 不在轨道上 */
  const [hoveredBar, setHoveredBar] = React.useState<number | null>(null)
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(new Set())
  /** 视口内无 uuid 条目的匹配键（用于高亮），与 visibleIds 同时机更新 */
  const [visibleNavKeys, setVisibleNavKeys] = React.useState<Set<string>>(new Set())
  /** 面板打开时快照：本地 DOM 里真正存在的消息 id（有 uuid 的） */
  const [loadedIds, setLoadedIds] = React.useState<Set<string>>(new Set())
  /** 面板打开时快照：本地 DOM 里无 uuid 条目的匹配键（如 interruption_record）；
   *  用“是否在 DOM”而非“是否在视口”，否则滚出屏幕的已加载行会被误标为未加载。 */
  const [loadedNavKeys, setLoadedNavKeys] = React.useState<Set<string>>(new Set())
  /** 主区视口几何中心当前对应的消息 id —— 面板打开时作为列表居中锚点 */
  const [centerVisibleId, setCenterVisibleId] = React.useState<string | undefined>(undefined)
  const [canScroll, setCanScroll] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isDragging, setIsDragging] = React.useState(false)
  const [scrollMetrics, setScrollMetrics] = React.useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 })
  const panelRef = React.useRef<HTMLDivElement>(null)
  /** 轨道本体：右键入口与「点外面关闭」的边界都挂在它上面 */
  const railRef = React.useRef<HTMLDivElement>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  /** 滚动进度条按需显隐：只有用户滚动时才露出，停手约 1.25s 后隐藏。 */
  React.useEffect(() => {
    if (!canScroll) return
    const track = trackRef.current
    if (!track) return
    const reveal = attachScrollbarReveal(track, { watchElement: scrollRef.current })
    return () => reveal.dispose()
  }, [scrollRef, canScroll])

  /**
   * 一轮 = 一条用户消息 + 它的回复（见 lib/navigation-turns）。
   *
   * 人找东西时想的是「我问了什么、它答了什么」，不是「第 17 条消息」，
   * 所以刻度、预览、面板列表全部以轮为单位。
   */
  const turns = React.useMemo(() => groupNavigationTurns(items), [items])

  // ── 可见消息 + 滚动指标追踪 ──

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    return observeMinimapViewport(el, contentRef.current, ({ scrollTop, scrollHeight, clientHeight, ids, keys, centerId }) => {
      setCanScroll(scrollHeight > clientHeight + 10)
      setScrollMetrics(previous => previous.scrollTop === scrollTop && previous.scrollHeight === scrollHeight
        && previous.clientHeight === clientHeight ? previous : { scrollTop, scrollHeight, clientHeight })
      setVisibleIds(previous => sameIds(previous, ids) ? previous : ids)
      setVisibleNavKeys(previous => sameIds(previous, keys) ? previous : keys)
      setCenterVisibleId(centerId)
    })
  }, [scrollRef, contentRef, items])

  // ── 面板打开时自动聚焦搜索框 ──

  React.useEffect(() => {
    if (panelOpen && searchInputRef.current) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 80)
      return () => clearTimeout(timer)
    }
  }, [panelOpen])

  // ── 面板打开时把当前可见消息滚到列表中间，避免每次都从顶部开始 ──

  React.useEffect(() => {
    if (!panelOpen) return
    const timer = setTimeout(() => {
      const list = listRef.current
      if (!list) return
      const target = list.querySelector<HTMLElement>('[data-minimap-visible="true"]')
      if (!target) return
      // listRef 没有 position 设置，offsetTop / getOffsetTopRelativeTo 都不可靠，
      // 直接用 getBoundingClientRect 计算 target 相对 list 视口的偏移
      const listRect = list.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offsetInList = (targetRect.top - listRect.top) + list.scrollTop
      const offset = offsetInList - (list.clientHeight - target.offsetHeight) / 2
      list.scrollTo({ top: Math.max(0, offset), behavior: 'auto' })
    }, 0)
    return () => clearTimeout(timer)
  }, [panelOpen])

  // ── 面板关闭时清空搜索 ──

  React.useEffect(() => {
    if (!panelOpen) setSearchQuery('')
  }, [panelOpen])

  // ── “已加载于本地 DOM”快照 ──
  //
  // 导航索引覆盖全会话，但本会话只加载了尾部一页消息（更早的要点「加载更早消息」才渲染）。
  // 面板需要区分「点得动」与「还没加载」：前者按 id（有 uuid）或 nav-key 在 DOM 里命中。
  // 只在面板打开时扫一次，不挂到滚动热路径上。

  React.useEffect(() => {
    if (!panelOpen) {
      setLoadedIds(new Set())
      setLoadedNavKeys(new Set())
      return
    }
    const el = scrollRef.current
    if (!el) return
    const ids = new Set<string>()
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = node.getAttribute('data-message-id')
      if (id) ids.add(id)
    }
    const keys = new Set<string>()
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-nav-key]')) {
      const key = node.getAttribute('data-message-nav-key')
      if (key) keys.add(key)
    }
    setLoadedIds(ids)
    setLoadedNavKeys(keys)
  }, [panelOpen, scrollRef, items])

  // ── Cmd+F / Ctrl+F 快捷键：打开面板并聚焦搜索 ──

  /**
   * 打开 / 关闭都是瞬时的：面板不做入场动画。
   *
   * 那层 zoom-in/fade-in 在反复开关、沿着轨道滑动时只会拖慢手感——
   * 要的是指针一停就看到内容，不是等一个过渡跑完。
   */
  const closePanel = React.useCallback(() => setPanelOpen(false), [])

  const handleShortcutOpen = React.useCallback(() => {
    // 面板和悬停预览共用左侧空间，开面板时先收起预览，否则会浮在面板上
    setHoveredBar(null)
    setPanelOpen(true)
  }, [])

  useShortcut('file-find', handleShortcutOpen, turns.length >= MIN_ITEMS && canScroll)

  // ── 点击面板外部 / Esc 关闭 ──
  //
  // 面板只由「右键轨道」或 ⌘F 打开，必须显式提供关闭路径：
  // 否则用户把鼠标移开去读正文时，面板还挡在那里。

  React.useEffect(() => {
    if (!panelOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      // 只处理左键：右键是轨道的开关手势，别让「点外面关闭」先把它关掉再重新打开
      if (event.button !== 0) return
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (railRef.current?.contains(target)) return
      closePanel()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePanel()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panelOpen, closePanel])

  // ── 轨道悬停：只给单条预览，不弹面板 ──

  /**
   * 沿轨道滑动时预览即时跟随，不设延迟。
   *
   * 旧实现要等 120ms 才出气泡，快速划过时既看不到内容，又有明显的迟滞感；
   * 气泡里只有纯文本（不做 markdown 解析），逐格切换不会卡。
   */
  const handleBarEnter = React.useCallback((index: number) => {
    // 面板打开时不再出预览：两者占同一块左侧空间
    if (panelOpen) return
    setHoveredBar(index)
  }, [panelOpen])

  /** 离开整条轨道才收起预览：横杠之间移动不经过这里，不会闪 */
  const handleRailLeave = React.useCallback(() => setHoveredBar(null), [])

  /**
   * 右键轨道 = 打开/关闭消息导航面板。
   *
   * 轨道顶部原本有一个独立的导航按钮，但它在 36px 宽的刻度列里是孤零零一个图标，
   * 和刻度不是同一套东西。右键本来就是「对这块区域做点别的」的语义，把入口并进来：
   * 顶部只剩刻度，左键仍然只负责「跳到那一条」，键盘路径保留 ⌘F。
   */
  const handleRailContextMenu = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (panelOpen) {
      closePanel()
      return
    }
    handleShortcutOpen()
  }, [panelOpen, closePanel, handleShortcutOpen])

  // ── 跳转到指定消息（直接操作 scrollTop，绕过 scrollIntoView） ──
  //
  // 导航索引覆盖全会话，但更早的行可能还没加载进 DOM。命中不了且仍有更早历史时，
  // 先拉起更早一页，让用户知道「在加载」而不是点了没反应；已加载到底则静默返回。

  const scrollToMessage = React.useCallback((id: string | null, matchKey?: string) => {
    const el = scrollRef.current
    if (!el) return
    const target = findMessageNode(el, id, matchKey)
    if (!target) {
      // 还没加载到那条历史：先拉起更早一页。
      // prepend 会把内容整体向下推，必须当锚点布局事务处理，否则用户会被推离当前位置。
      if (onRequestEarlier) {
        const finish = beginLayout(contentRef.current ?? undefined)
        onRequestEarlier()
        // 内容异步到达；下一帧结束事务，让控制器在新高度下把锚点抳回原位。
        window.setTimeout(finish, 0)
      }
      return
    }
    const offsetTop = getOffsetTopRelativeTo(target, el)
    const targetHeight = target.offsetHeight
    const viewportHeight = el.clientHeight
    const scrollTarget = targetHeight < viewportHeight
      ? offsetTop - (viewportHeight - targetHeight) / 2
      : offsetTop - 32
    navigate(Math.max(0, scrollTarget))

    closePanel()
  }, [scrollRef, contentRef, navigate, onRequestEarlier, beginLayout, closePanel])

  // ── 按轮分组后的派生数据 ──

  /**
   * 该条目是否已在本会话的 DOM 里。
   *
   * 导航索引覆盖全会话，但只加载了尾部一页；更早的条目点不动（需要先加载），
   * 面板据此把它们标为「未加载」，而不是让用户以为点了没反应。
   */
  const isLoaded = React.useCallback(
    (item: MinimapItem): boolean => {
      if (item.id) return loadedIds.has(item.id)
      if (item.matchKey) return loadedNavKeys.has(item.matchKey)
      return false
    },
    [loadedIds, loadedNavKeys],
  )

  /** 该条目当前是否在视口内（用于高亮与悬浮定位）。 */
  const isOnScreen = React.useCallback(
    (item: MinimapItem): boolean => (item.id ? visibleIds.has(item.id) : item.id === null && item.matchKey !== undefined ? visibleNavKeys.has(item.matchKey) : false),
    [visibleIds, visibleNavKeys],
  )

  /** 这一轮是否在视口内：任一条目在视口即可（长回复跨屏时也不会漏高亮）。 */
  const isTurnOnScreen = React.useCallback(
    (turn: NavigationTurn<MinimapItem>): boolean => turn.items.some(isOnScreen),
    [isOnScreen],
  )

  /** 搜索：一轮里任何一条（提问 / 回复 / 中断记录）命中都算命中。 */
  const filteredTurns = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return turns
    return turns.filter((turn) => turn.items.some((item) => item.preview.toLowerCase().includes(q)))
  }, [turns, searchQuery])

  /** 已加载的轮数：锚点在 DOM 里才算点得动。 */
  const loadedCount = React.useMemo(
    () => turns.filter((turn) => isLoaded(turn.anchor)).length,
    [turns, isLoaded],
  )

  /** 列表居中锚点：优先用主区视口中心所在的那一轮；被搜索过滤掉时退回第一条可见轮。 */
  const anchorKey = React.useMemo(() => {
    const centerTurn = centerVisibleId
      ? filteredTurns.find((turn) => turn.items.some((item) => item.id === centerVisibleId))
      : undefined
    const onScreenTurn = centerTurn ?? filteredTurns.find(isTurnOnScreen)
    return onScreenTurn?.key
  }, [centerVisibleId, filteredTurns, isTurnOnScreen])

  /** 当前阅读位置（1 基，按轮计）。找不到可见轮时为 0，面板显示为「—」。 */
  const anchorIndex = React.useMemo(() => {
    if (!anchorKey) return 0
    return filteredTurns.findIndex((turn) => turn.key === anchorKey) + 1
  }, [anchorKey, filteredTurns])

  //
  // 只渲染列表窗口（见 MAX_LIST_ITEMS）；窗口围绕当前阅读位置，而不是固定取尾部：
  // 否则用户上滚阅读时，面板里的高亮行会被挤出窗口，看不到自己读到哪。
  // 计数/位置指示仍用全量 filteredTurns。
  const listTurns = React.useMemo(() => {
    if (filteredTurns.length <= MAX_LIST_ITEMS) return filteredTurns
    if (anchorIndex <= 0) return filteredTurns.slice(-MAX_LIST_ITEMS)
    const half = Math.floor(MAX_LIST_ITEMS / 2)
    const start = Math.max(0, Math.min(anchorIndex - 1 - half, filteredTurns.length - MAX_LIST_ITEMS))
    return filteredTurns.slice(start, start + MAX_LIST_ITEMS)
  }, [filteredTurns, anchorIndex])

  // ── 滚动条滑块拖拽 ──

  const handleThumbMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const el = scrollRef.current
    const track = trackRef.current
    if (!el || !track) return

    pause()

    setIsDragging(true)
    const startY = e.clientY
    const startScrollTop = el.scrollTop
    const trackHeight = track.clientHeight
    const { scrollHeight, clientHeight } = el
    const scrollRange = scrollHeight - clientHeight
    const thumbHeight = Math.max(trackHeight * 0.1, (clientHeight / scrollHeight) * trackHeight)
    const scrollableTrack = trackHeight - thumbHeight

    const onMouseMove = (ev: MouseEvent): void => {
      ev.preventDefault()
      const delta = ev.clientY - startY
      const scrollDelta = scrollableTrack > 0 ? (delta / scrollableTrack) * scrollRange : 0
      navigate(Math.max(0, Math.min(scrollRange, startScrollTop + scrollDelta)), false)
    }

    const onMouseUp = (): void => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [scrollRef, pause, navigate])

  // ── 轨道点击跳转 ──
  const handleTrackMouseDown = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 只响应直接点击轨道背景，忽略点击滑块
    if (e.target !== e.currentTarget) return

    const track = trackRef.current
    const el = scrollRef.current
    if (!track || !el) return

    const rect = track.getBoundingClientRect()
    const clickRatio = (e.clientY - rect.top) / rect.height
    const { scrollHeight, clientHeight } = el
    const targetTop = clickRatio * (scrollHeight - clientHeight)
    navigate(Math.max(0, targetTop))
  }, [scrollRef, navigate])

  if (turns.length < MIN_ITEMS || !canScroll) return null

  // ── 迷你地图条纹 ──

  const barCount = Math.min(turns.length, MAX_BARS)

  /** 悬停中的横杠所代表的那一轮（横杠按区间分桶，取桶内第一轮） */
  const hoveredBarIndex = hoveredBar === null ? -1 : Math.floor((hoveredBar * turns.length) / barCount)
  const hoveredTurn = hoveredBar === null ? undefined : turns[hoveredBarIndex]

  // ── 滚动条滑块尺寸计算 ──

  const { scrollTop, scrollHeight, clientHeight } = scrollMetrics
  const scrollRange = scrollHeight - clientHeight
  const thumbRatio = scrollHeight > 0 ? Math.min(clientHeight / scrollHeight, 1) : 1
  const thumbHeightPct = Math.max(10, thumbRatio * 100)
  const thumbTopPct = scrollRange > 0 ? (scrollTop / scrollRange) * (100 - thumbHeightPct) : 0

  // ── 轨道刻度 ──
  //
  // 一轮一根等长短杠，不编码任何数据；长短只回应指针。当前视口用浅色标出，
  // 回答“我读到哪了”——这是它作为导航的全部职责，其余交给预览与面板。
  const railBars = Array.from({ length: barCount }, (_, i) => {
    const start = Math.floor((i * turns.length) / barCount)
    const end = Math.floor(((i + 1) * turns.length) / barCount)
    const group = turns.slice(start, end)
    return {
      first: group[0],
      firstIndex: start,
      isVisible: group.some(isTurnOnScreen),
      hasAnswer: group.some((turn) => Boolean(turn.assistant)),
      loaded: group.some((turn) => isLoaded(turn.anchor)),
    }
  })

  // 悬停时按距离衰减：自己最长，上下邻居依次变短（见 WAVE_FALLOFF）
  const waveWidth = (index: number): number => {
    if (hoveredBar === null) return REST_WIDTH
    const factor = WAVE_FALLOFF[Math.abs(index - hoveredBar)] ?? 0
    return Math.round(REST_WIDTH + (PEAK_WIDTH - REST_WIDTH) * factor)
  }

  return (
    <>
      {/* ── 左中轨道 ──
          放在正文左侧、纵向居中：它是一份目录刻度，不是贴边的滚动条。
          指针压到某一根时，它自己和上下邻居按距离衰减伸长，滑动时就是一道跟着走的起伏。 */}
      <div className="absolute left-1 top-1/2 z-30 -translate-y-1/2 pointer-events-none">
        <div
          ref={railRef}
          role="group"
          aria-label="消息导航（右键打开）"
          className="flex flex-col items-start pointer-events-auto"
          onMouseLeave={handleRailLeave}
          onContextMenu={handleRailContextMenu}
        >
          {railBars.map(({ first, firstIndex, isVisible, hasAnswer, loaded }, i) => {
            const isHovered = hoveredBar === i
            return (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                aria-label={first ? `跳转到第 ${firstIndex + 1} 轮：${first.preview.slice(0, 40)}` : '跳转到对话'}
                onMouseEnter={() => handleBarEnter(i)}
                onClick={() => first && scrollToMessage(first.anchor.id, first.anchor.matchKey)}
                className="relative flex h-2 w-9 items-center focus:outline-none"
              >
                <span
                  className={cn(
                    // 150ms 的跟随：沿轨道滑动时，起伏是一道跟着指针走的波，而不是逐格硬跳
                    'block h-[3px] rounded-full transition-[width,background-color] duration-150 ease-out',
                    isVisible
                      ? 'bg-foreground/70 dark:bg-foreground/75 minimap-visible-indicator'
                      : hasAnswer
                        ? 'bg-foreground/40 dark:bg-foreground/40'
                        : 'bg-foreground/20 dark:bg-foreground/25',
                    !loaded && 'opacity-40',
                    isHovered && 'bg-foreground dark:bg-foreground'
                  )}
                  style={{ width: waveWidth(i) }}
                />

                {/* 悬停预览：一轮 = 提问 + 回复，贴着被悬停的那一根向右展开。
                    一张卡、两块内容、只用间距分隔：不做分割线、不加标题行、不做入场动画——
                    指针滑过时它就是一块跟着走的内容，而不是一堆被线切碎的小格子。 */}
                {isHovered && !panelOpen && hoveredTurn && (
                  <div className="pointer-events-none absolute left-full top-1/2 z-40 ml-4 w-[280px] -translate-y-1/2 rounded-lg border bg-popover px-2.5 py-2 shadow-lg">
                    <div className="flex items-start gap-1.5">
                      <ItemIcon item={hoveredTurn.user ?? hoveredTurn.anchor} />
                      <p className="line-clamp-2 text-xs leading-relaxed text-popover-foreground/85">
                        {hoveredTurn.preview.trim() || '(空消息)'}
                      </p>
                    </div>
                    {hoveredTurn.assistant && (
                      <div className="mt-1.5 flex items-start gap-1.5">
                        <ItemIcon item={hoveredTurn.assistant} />
                        <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/75">
                          {hoveredTurn.assistant.preview.trim() || '(空回复)'}
                        </p>
                      </div>
                    )}
                    {!hoveredTurn.assistant && hoveredTurn.status && (
                      <div className="mt-1.5 flex items-start gap-1.5 text-destructive/80">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <p className="line-clamp-2 text-[11px] leading-relaxed">{hoveredTurn.status.preview}</p>
                      </div>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* 展开面板：从左侧轨道向右弹开（无入场动画，打开即到位） */}
        {panelOpen && (
          <div
            ref={panelRef}
            className="absolute left-full top-1/2 ml-4 w-[300px] -translate-y-1/2 rounded-lg border bg-popover shadow-xl flex flex-col overflow-hidden pointer-events-auto"
            style={{ maxHeight: 'min(460px, 70vh)' }}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
              <span className="text-xs font-medium text-popover-foreground/70">消息导航</span>
              <span
                className="text-[11px] text-muted-foreground tabular-nums"
                title={`已加载 ${loadedCount}/${turns.length} 轮`}
              >
                {anchorIndex > 0 ? `第 ${anchorIndex} 轮 / 共 ${turns.length} 轮` : `— / 共 ${turns.length} 轮`}
              </span>
            </div>

            {/* 搜索框 */}
            <div className="px-2 py-1.5 border-b shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
                <Input
                  ref={searchInputRef}
                  placeholder="搜索对话..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-7 text-xs pl-7"
                />
              </div>
            </div>

            {/* 对话列表（一轮一行） */}
            <div ref={listRef} className="overflow-y-auto flex-1 p-1.5 space-y-0.5 scrollbar-thin">
              {filteredTurns.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  未找到匹配对话
                </div>
              ) : (
                listTurns.map((turn) => (
                  <TurnRow
                    key={turn.key}
                    turn={turn}
                    isAnchor={turn.key === anchorKey}
                    loaded={isLoaded(turn.anchor)}
                    onScreen={isTurnOnScreen(turn)}
                    query={searchQuery}
                    onSelect={scrollToMessage}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 滚动进度条（仍在右边缘，和轨道分工：左边读位置，右边拖滚动） ── */}
      <div className="absolute right-1 top-0 bottom-0 z-30 py-4 pointer-events-none">
        <div
          ref={trackRef}
          data-dragging={isDragging || undefined}
          className="scroll-progress-track relative h-full rounded-full cursor-pointer"
          onMouseDown={handleTrackMouseDown}
        >
          <div
            className={cn(
              'absolute left-0 right-0 rounded-full transition-colors duration-100 scroll-progress-thumb',
              isDragging
                ? 'scroll-progress-thumb-active cursor-grabbing'
                : 'cursor-grab'
            )}
            style={{ height: `${thumbHeightPct}%`, top: `${thumbTopPct}%` }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      </div>
    </>
  )
}

// ── 子组件 ──

/**
 * 面板列表的一行 = 一轮对话。独立出来 memo 化：面板开启时滚动会持续重算“可见/已加载”状态，
 * 避免每行（含 markdown 预览）在无关项变化时重建。
 *
 * 一行两段：上面是用户提问（可点击的那句），下面是助手回复摘要；
 * 收尾状态（中断记录等）跟在最后一行，不单独占一行。
 */
const TurnRow = React.memo(function TurnRow({
  turn,
  isAnchor,
  loaded,
  onScreen,
  query,
  onSelect,
}: {
  turn: NavigationTurn<MinimapItem>
  isAnchor: boolean
  loaded: boolean
  onScreen: boolean
  query: string
  onSelect: (id: string | null, matchKey?: string) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      data-minimap-visible={isAnchor ? 'true' : undefined}
      title={loaded ? undefined : '尚未加载这一轮，点击将先加载更早消息'}
      className={cn(
        'flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
        onScreen && 'bg-accent/50',
        !loaded && 'opacity-45'
      )}
      onClick={() => onSelect(turn.anchor.id, turn.anchor.matchKey)}
    >
      <ItemIcon item={turn.user ?? turn.anchor} />
      <div className="flex-1 min-w-0">
        <HighlightedPreview text={turn.preview} query={query} />
        {turn.assistant && (
          <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-muted-foreground/70">
            {turn.assistant.preview || '(空回复)'}
          </p>
        )}
        {turn.status && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] leading-snug text-destructive/75">
            <AlertTriangle className="size-3 shrink-0" />
            <span className="line-clamp-1">{turn.status.preview}</span>
          </p>
        )}
      </div>
    </button>
  )
})

function ItemIcon({ item }: { item: MinimapItem }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if ((item.role === 'assistant') && item.model) {
    return (
      <img
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
  }
  return <div className="size-4 shrink-0 mt-0.5 rounded-[20%] bg-muted" />
}

/** Markdown 预览（无搜索时）或 纯文本+高亮（搜索时） */
function HighlightedPreview({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!text) {
    return <span className="text-xs opacity-40">(空消息)</span>
  }

  if (query.trim()) {
    const escaped = escapeRegExp(query)
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return (
      <span className="text-xs text-popover-foreground/80 line-clamp-2">
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase()
            ? <mark key={i} className="bg-primary/20 text-primary rounded-sm px-0.5">{part}</mark>
            : part
        )}
      </span>
    )
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-popover-foreground/80 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-2 overflow-hidden">
      <MarkdownPreview components={MARKDOWN_PREVIEW_LIGHT_COMPONENTS}>
        {text}
      </MarkdownPreview>
    </div>
  )
}
