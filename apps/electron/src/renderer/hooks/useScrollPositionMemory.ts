/** 阅读位置记忆：跟随状态只保存模式，阅读状态保存稳定消息锚点与视口偏移。 */
import { useEffect, useRef } from 'react'
import { useConversationScroll } from '@/components/ai-elements/conversation-scroll'
import type { ReadingPosition } from '@/components/ai-elements/conversation-scroll-controller'

const SCROLL_CACHE_MAX = 50
const scrollPositionCache = new Map<string, ReadingPosition | null>()

function setScrollPosition(id: string, position: ReadingPosition | null): void {
  scrollPositionCache.delete(id)
  scrollPositionCache.set(id, position)
  if (scrollPositionCache.size > SCROLL_CACHE_MAX) {
    const oldest = scrollPositionCache.keys().next().value
    if (oldest !== undefined) scrollPositionCache.delete(oldest)
  }
}

export function ScrollPositionManager({ id, ready }: { id: string; ready: boolean }): null {
  const { scrollRef, restore, follow, snapshot } = useConversationScroll()
  const restoredId = useRef<string | null>(null)

  // passive effect 在共享 controller 的 layout 初始化之后运行，无竞争性的二次 rAF 写入。
  useEffect(() => {
    if (!ready || !scrollRef.current) return
    if (restoredId.current !== id) {
      restoredId.current = id
      const saved = scrollPositionCache.get(id)
      if (saved) restore(saved)
      else follow(false)
    }

    const el = scrollRef.current
    const save = (): void => setScrollPosition(id, snapshot())
    el.addEventListener('scroll', save, { passive: true })
    return () => {
      save()
      el.removeEventListener('scroll', save)
    }
  }, [id, ready, scrollRef, restore, follow, snapshot])

  return null
}
