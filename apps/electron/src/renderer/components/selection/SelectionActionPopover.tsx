import * as React from 'react'
import { Quote } from 'lucide-react'

interface SelectionActionPopoverProps {
  x: number
  y: number
  direction?: 'up' | 'down'
  onAddToAgent: () => void
}

export interface AvoidRect {
  left: number
  top: number
  width: number
  height: number
}

function rectIntersects(
  a: { left: number; top: number; width: number; height: number },
  b: AvoidRect,
): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top
}

/** 避开禁区时在禁区边缘额外留出的空隙（防止按钮与「回到底端」按钮紧挨着）。 */
const AVOID_GAP = 12

/** 计算把按钮（含 translate 变换后的实际区域）钳制回视口内所需的平移量；
 *  若给定禁区（avoid）且按钮与它重叠，向右平移绕过禁区（保持垂直位置不变）。 */
export function computeViewportShift(
  rect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
  avoid: AvoidRect | null = null,
): { dx: number; dy: number } {
  const clampLeft = Math.min(Math.max(rect.left, 0), Math.max(viewportWidth - rect.width, 0))
  const clampTop = Math.min(Math.max(rect.top, 0), Math.max(viewportHeight - rect.height, 0))
  let dx = clampLeft - rect.left
  let dy = clampTop - rect.top
  if (avoid && rectIntersects({ left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height }, avoid)) {
    // 右移绕过：按钮左缘移到禁区右侧（留 AVOID_GAP），保持垂直位置不变
    dx = avoid.left + avoid.width + AVOID_GAP - rect.left
    // 确保不超出视口右缘
    dx = Math.min(dx, viewportWidth - rect.width - rect.left)
  }
  return { dx, dy }
}

/** 会话区底部中央的「回到底端」浮动按钮（conversation.tsx 的 ConversationScrollButton）。 */
const SCROLL_TO_BOTTOM_SELECTOR = '[data-scroll-to-bottom]'

function findScrollToBottomRect(): AvoidRect | null {
  const el = document.querySelector<HTMLElement>(SCROLL_TO_BOTTOM_SELECTOR)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export function SelectionActionPopover({
  x,
  y,
  direction = 'up',
  onAddToAgent,
}: SelectionActionPopoverProps): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement>(null)
  // direction 'up' 向上展开（按钮底部贴锚点）；'down' 向下展开（按钮顶部贴锚点）。
  const translateClass = direction === 'down' ? '-translate-x-1/2' : '-translate-x-1/2 -translate-y-full'

  // 自我钳制：实测按钮渲染区域（含 translate 变换后的实际位置），越界时整体平移回视口内，
  // 并右移绕过「回到底端」浮动按钮，保证两个按钮不重叠、都可点击。
  React.useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const { dx, dy } = computeViewportShift(
      el.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
      findScrollToBottomRect(),
    )
    if (dx !== 0 || dy !== 0) {
      el.style.left = `${x + dx}px`
      el.style.top = `${y + dy}px`
    }
  }, [x, y, direction])

  return (
    <div
      ref={rootRef}
      data-selection-action-popover
      className={`fixed z-[90] ${translateClass} rounded-xl bg-popover/95 px-2 py-1.5 text-popover-foreground shadow-xl ring-1 ring-border/40 backdrop-blur`}
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors hover:bg-muted"
          onClick={onAddToAgent}
        >
          <Quote className="size-4 rotate-180 -translate-y-[3px]" />
          为 Agent 引用
        </button>
      </div>
    </div>
  )
}
