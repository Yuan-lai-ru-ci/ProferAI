import * as React from 'react'
import { Bot } from 'lucide-react'

interface SelectionActionPopoverProps {
  x: number
  y: number
  onAddToAgent: () => void
}

/** 计算把已渲染的按钮（含 translate 变换后的实际区域）整体平移回视口内所需的偏移量。 */
export function computeViewportShift(
  rect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): { dx: number; dy: number } {
  const clampLeft = Math.min(Math.max(rect.left, 0), Math.max(viewportWidth - rect.width, 0))
  const clampTop = Math.min(Math.max(rect.top, 0), Math.max(viewportHeight - rect.height, 0))
  return { dx: clampLeft - rect.left, dy: clampTop - rect.top }
}

export function SelectionActionPopover({
  x,
  y,
  onAddToAgent,
}: SelectionActionPopoverProps): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement>(null)

  // 自我钳制：实测按钮渲染区域（含 translate 变换后的实际位置），越界时整体平移回视口内，
  // 保证按钮完整可见、可点击。比在调用方按估算尺寸钳制更精确，且对任意调用方通用。
  React.useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const { dx, dy } = computeViewportShift(el.getBoundingClientRect(), window.innerWidth, window.innerHeight)
    if (dx !== 0 || dy !== 0) {
      el.style.left = `${x + dx}px`
      el.style.top = `${y + dy}px`
    }
  }, [x, y])

  return (
    <div
      ref={rootRef}
      data-selection-action-popover
      className="fixed z-[90] -translate-x-1/2 -translate-y-full rounded-xl bg-popover/95 px-2 py-1.5 text-popover-foreground shadow-xl ring-1 ring-border/40 backdrop-blur"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors hover:bg-muted"
          onClick={onAddToAgent}
        >
          <Bot className="size-4" />
          为 Agent 引用
        </button>
      </div>
    </div>
  )
}
