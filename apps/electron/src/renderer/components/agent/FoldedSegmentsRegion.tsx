import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOptionalConversationScroll } from '@/components/ai-elements/conversation-scroll'

/**
 * 找到最近的纵向可滚动祖先。
 *
 * 只看 overflowY，不附加 `scrollHeight > clientHeight` 判断：元素在展开瞬间可能还不可滚，
 * 但滚动容器本身是稳定的，判断它是否可滚反而会漏判。
 */
export function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null
  while (node) {
    const { overflowY } = window.getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

export interface FoldedSegmentsRegionProps {
  /** 被折叠的段数（用于文案） */
  count: number
  /** 展开时渲染被折叠的段；折叠时不调用 */
  renderRevealed: () => React.ReactNode
  /** 可选的受控展开状态；用于流式窗口重算后保留用户选择。 */
  expanded?: boolean
  /** 受控展开状态变更回调。 */
  onExpandedChange?: (expanded: boolean) => void
}

/**
 * 被折叠段的展开区。
 *
 * 三条行为约束（都来自用户明确要求）：
 * 1. 展开/收起后**下方内容不位移**——插入的内容向上撑开，用户视线落点保持不动。
 *    做法：区域末尾放一个零高度锚点，切换前记录它的视口位置，切换后用
 *    `useLayoutEffect` 在同一帧内补偿滚动量（paint 之前完成，不会闪一下）。
 * 2. 展开后要有**收起**入口——折叠态与展开态各自可点，构成主动折叠闭环。
 * 3. 展开状态默认由调用方按 turn 生命周期持有；没有传入受控状态时才使用本组件内部状态。
 *    这样过程块因流式窗口变化重新挂载时，不会覆盖用户已经展开的选择。
 */
export function FoldedSegmentsRegion({ count, renderRevealed, expanded, onExpandedChange }: FoldedSegmentsRegionProps): React.ReactElement | null {
  const [internalRevealed, setInternalRevealed] = React.useState(false)
  const revealed = expanded ?? internalRevealed
  const anchorRef = React.useRef<HTMLDivElement>(null)
  const scroll = useOptionalConversationScroll()
  const pendingRef = React.useRef<{ top: number; scroller: HTMLElement; finish?: () => void } | null>(null)

  const toggle = React.useCallback((next: boolean) => {
    const anchor = anchorRef.current
    const scroller = findScrollParent(anchor)
    if (anchor && scroller) {
      pendingRef.current = {
        top: anchor.getBoundingClientRect().top,
        scroller,
        finish: scroll?.beginLayout(anchor),
      }
    }
    if (expanded === undefined) setInternalRevealed(next)
    onExpandedChange?.(next)
  }, [expanded, onExpandedChange, scroll])

  // 无依赖数组：每次渲染后检查是否有待补偿的滚动量。
  // useLayoutEffect 在 DOM 变更后、浏览器 paint 前同步执行，不会看到跳动。
  React.useLayoutEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    const anchor = anchorRef.current
    if (!anchor) return
    if (pending.finish) {
      pending.finish()
      return
    }
    const delta = anchor.getBoundingClientRect().top - pending.top
    if (delta !== 0) pending.scroller.scrollTop += delta
  })

  if (count <= 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(!revealed)}
        aria-expanded={revealed}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-left text-[12px] text-muted-foreground/70 transition-colors',
          'hover:bg-muted/40 hover:text-muted-foreground',
        )}
      >
        {revealed
          ? <ChevronDown className="size-3.5 shrink-0" />
          : <ChevronUp className="size-3.5 shrink-0" />}
        <span>{revealed ? `收起更早的 ${count} 段` : `更早的 ${count} 段已折叠，点击展开`}</span>
      </button>

      {revealed && <div className="mt-2 space-y-2">{renderRevealed()}</div>}

      {/* 零高度锚点：始终紧贴下方可见内容，展开/收起时用它把下方内容拉回原位 */}
      <div ref={anchorRef} aria-hidden className="h-0" />
    </div>
  )
}
