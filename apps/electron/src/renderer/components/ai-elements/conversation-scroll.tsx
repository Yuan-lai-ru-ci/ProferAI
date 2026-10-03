import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react'
import { ConversationScrollController, type ReadingPosition } from './conversation-scroll-controller'

export interface ConversationScrollActions {
  following: boolean
  scrollRef: MutableRefObject<HTMLDivElement | null>
  contentRef: MutableRefObject<HTMLDivElement | null>
  follow: (smooth?: boolean) => void
  pause: () => void
  navigate: (top: number, smooth?: boolean) => void
  beginLayout: (anchor?: HTMLElement) => () => void
  restore: (position: ReadingPosition) => void
  snapshot: () => ReadingPosition | null
}

const ScrollActionsContext = createContext<ConversationScrollActions | null>(null)

export function useConversationScroll(): ConversationScrollActions {
  const context = useContext(ScrollActionsContext)
  if (!context) throw new Error('Conversation scroll actions require a Conversation')
  return context
}

export function useOptionalConversationScroll(): ConversationScrollActions | null {
  return useContext(ScrollActionsContext)
}

export function ConversationScrollProvider({ children, smoothResize }: {
  children: ReactNode | ((context: ConversationScrollActions) => ReactNode)
  smoothResize: boolean
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const resizeRef = useRef(smoothResize)
  resizeRef.current = smoothResize
  const controller = useRef<ConversationScrollController | null>(null)
  const disposedSnapshot = useRef<{ following: boolean; position: ReadingPosition | null } | null>(null)
  const [following, setFollowing] = useState(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const instance = new ConversationScrollController({
      viewport: el,
      reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      changed: () => setFollowing(instance.following),
    })
    controller.current = instance
    if (disposedSnapshot.current) {
      const saved = disposedSnapshot.current
      if (!saved.following && saved.position) instance.restore(saved.position)
      else instance.follow(false)
    }
    const onScroll = (): void => instance.scrolled()
    const nestedScroller = (target: EventTarget | null): boolean => {
      let node = target instanceof HTMLElement ? target : null
      while (node && node !== el) {
        const overflow = getComputedStyle(node).overflowY
        if (/auto|scroll/.test(overflow) && node.scrollHeight > node.clientHeight) return true
        node = node.parentElement
      }
      return false
    }
    const onWheel = (event: WheelEvent): void => {
      if (nestedScroller(event.target)) return
      instance.userInput()
      if (event.deltaY < 0 && el.scrollHeight > el.clientHeight) instance.pause()
    }
    const onPointer = (): void => instance.userInput()
    const onKey = (event: KeyboardEvent): void => {
      if (nestedScroller(event.target)) return
      if (event.target instanceof HTMLElement && (event.target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) instance.userInput()
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) instance.pause()
    }
    let touchY: number | null = null
    const onTouchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY ?? null }
    const onTouchMove = (event: TouchEvent): void => {
      if (nestedScroller(event.target)) return
      instance.userInput()
      const y = event.touches[0]?.clientY
      if (y !== undefined && touchY !== null && y > touchY) instance.pause()
      touchY = y ?? null
    }
    const onSelection = (): void => {
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && selection.rangeCount > 0
        && el.contains(selection.getRangeAt(0).commonAncestorContainer)) instance.pause()
    }
    el.addEventListener('pointerdown', onPointer, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('selectionchange', onSelection)
    const observer = new ResizeObserver(() => instance.resized(resizeRef.current))
    observer.observe(el)
    if (contentRef.current) observer.observe(contentRef.current)
    instance.resized(false)
    return () => {
      disposedSnapshot.current = { following: instance.following, position: instance.snapshot() }
      instance.dispose()
      controller.current = null
      observer.disconnect()
      el.removeEventListener('pointerdown', onPointer)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('selectionchange', onSelection)
    }
  }, [])

  const actions = useRef<Omit<ConversationScrollActions, 'following'>>({
    scrollRef, contentRef,
    follow: (smooth = true) => controller.current?.follow(smooth),
    pause: () => controller.current?.pause(),
    navigate: (top, smooth = true) => controller.current?.navigate(top, smooth),
    beginLayout: (anchor) => controller.current?.beginLayout(anchor) ?? (() => {}),
    restore: (position) => controller.current?.restore(position),
    snapshot: () => controller.current ? controller.current.snapshot() : (disposedSnapshot.current?.position ?? null),
  })
  const context = { ...actions.current, following }
  return <ScrollActionsContext.Provider value={context}>
    {typeof children === 'function' ? children(context) : children}
  </ScrollActionsContext.Provider>
}
