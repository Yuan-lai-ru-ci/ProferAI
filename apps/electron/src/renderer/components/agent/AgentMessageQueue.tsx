import * as React from 'react'
import { Clock3, CornerDownLeft, GripVertical, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { cn } from '@/lib/utils'
import type { AgentQueuedMessage, QueueDropPlacement } from '@/lib/agent-message-queue'
import { parseQuotedSelectionRefs, stripQuoteMarkers } from '@/lib/quoted-selection'

interface AgentMessageQueueProps {
  items: AgentQueuedMessage[]
  /** 空闲且前置满足时才允许「立即发送」，运行中置灰 */
  canSendNow: boolean
  /** 当前队列是否会在本轮结束后自动发送 */
  autoSend: boolean
  onToggleAutoSend: () => void
  onSendNow: (messageId: string) => void
  onRecall: (messageId: string) => void
  onRemove: (messageId: string) => void
  onMove: (sourceId: string, targetId: string, placement: QueueDropPlacement) => void
}

/**
 * 运行中排队的消息面板（替代 `af4a7a6a` 删掉的那一版）。
 *
 * 与旧版的差别：队列项不再携带引用数据（引用已内联进正文），所以行里只有正文预览；
 * 顶部不再显示计数与说明文案，空列表直接不渲染。
 */
export function AgentMessageQueue({
  items,
  canSendNow,
  autoSend,
  onToggleAutoSend,
  onSendNow,
  onRecall,
  onRemove,
  onMove,
}: AgentMessageQueueProps): React.ReactElement | null {
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [dropTarget, setDropTarget] = React.useState<{ id: string; placement: QueueDropPlacement } | null>(null)

  if (items.length === 0) return null

  const resolvePlacement = (event: React.DragEvent<HTMLDivElement>): QueueDropPlacement => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>, targetId: string): void => {
    event.stopPropagation()
    if (!draggingId || draggingId === targetId) return
    event.preventDefault()
    setDropTarget({ id: targetId, placement: resolvePlacement(event) })
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, targetId: string): void => {
    event.stopPropagation()
    event.preventDefault()
    if (!draggingId || draggingId === targetId) return
    onMove(draggingId, targetId, resolvePlacement(event))
    setDraggingId(null)
    setDropTarget(null)
  }

  return (
    <div
      className="border-b border-border/35 bg-muted/[0.18] px-2.5 pt-2 pb-1.5"
      onDragEnter={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.stopPropagation()
        if (draggingId) event.preventDefault()
      }}
      onDragLeave={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-1 pb-1 text-[12px] text-muted-foreground">
        <Clock3 className="size-3.5" />
        <button
          type="button"
          role="switch"
          aria-checked={autoSend}
          onClick={onToggleAutoSend}
          title={autoSend ? '自动发送已开启：本轮结束自动发送队首' : '自动发送已关闭：需手动逐条「立即发送」'}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors',
            autoSend
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-600'
              : 'border-border bg-muted/40 text-muted-foreground/60 hover:text-foreground/80',
          )}
        >
          <span className={cn('size-1.5 rounded-full transition-colors', autoSend ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
          <span>自动发送</span>
        </button>
      </div>
      <div className="space-y-1">
        {items.map((item, index) => {
          const isDragging = draggingId === item.id
          const isDropBefore = dropTarget?.id === item.id && dropTarget.placement === 'before'
          const isDropAfter = dropTarget?.id === item.id && dropTarget.placement === 'after'

          return (
            <div
              key={item.id}
              draggable
              onDragStart={(event) => {
                event.stopPropagation()
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.id)
                setDraggingId(item.id)
              }}
              onDragOver={(event) => handleDragOver(event, item.id)}
              onDrop={(event) => handleDrop(event, item.id)}
              onDragEnd={(event) => {
                event.stopPropagation()
                setDraggingId(null)
                setDropTarget(null)
              }}
              className={cn(
                'relative flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                index === 0 ? 'bg-primary/[0.05]' : 'bg-background/35',
                isDragging && 'opacity-45',
                'hover:bg-background/60',
              )}
            >
              {isDropBefore && <div className="absolute left-2 right-2 top-0 h-0.5 rounded-full bg-primary" />}
              {isDropAfter && <div className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/55 active:cursor-grabbing" />
              <div className="min-w-0 flex-1 text-[13px] leading-5 text-foreground/80">
                <div className="line-clamp-2">{displayText(item.text)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <QueueIconButton label="立即发送" disabled={!canSendNow} onClick={() => onSendNow(item.id)}>
                  <CornerDownLeft className="size-3.5" />
                </QueueIconButton>
                <QueueIconButton label="撤回到输入框" onClick={() => onRecall(item.id)}>
                  <Undo2 className="size-3.5" />
                </QueueIconButton>
                <QueueIconButton label="删除" danger onClick={() => onRemove(item.id)}>
                  <Trash2 className="size-3.5" />
                </QueueIconButton>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 队列行只显示可见正文：引用块与 `[n]` 标记都在发送时展开，行里不重复渲染。 */
function displayText(text: string): string {
  const parsed = parseQuotedSelectionRefs(text)
  const stripped = stripQuoteMarkers(parsed.text, parsed.quotes.map((quote) => quote.ref))
  return stripped || parsed.text || text
}

interface QueueIconButtonProps {
  label: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}

function QueueIconButton({ label, disabled, danger, onClick, children }: QueueIconButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          className={cn('size-7 rounded-md text-muted-foreground hover:text-foreground', danger && 'hover:text-destructive')}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  )
}
