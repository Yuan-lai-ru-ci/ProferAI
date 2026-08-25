import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { AgentImageGenerationCard } from '@profer/shared'
import { cn } from '@/lib/utils'

/** This is transient status UI; succeeded/failed records are deliberately not rendered. */
export function imageGenerationStatusLabel(status: AgentImageGenerationCard['status']): string {
  return status === 'saving' ? '正在保存图片' : '正在请求图片服务'
}

function formatElapsed(card: AgentImageGenerationCard, now: number): string {
  const seconds = Math.max(0, Math.floor((now - card.createdAt) / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`
}

/** Compact, one-line progress indicator. Final images/errors stay in the normal Agent output/tool audit. */
export function AgentImageGenerationCardView({ card }: { card: AgentImageGenerationCard }): React.ReactElement | null {
  const [now, setNow] = React.useState(Date.now())
  const pending = card.status === 'requesting' || card.status === 'saving'
  React.useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [pending])
  if (!pending) return null

  const kind = card.reference.kind === 'last_generated' ? '编辑上一张图' : card.reference.kind === 'paths' ? '参考图编辑' : '文本生图'
  // Align with the normal Agent message body / running indicator, not the avatar column.
  return <div className="ml-[56px] my-2 flex max-w-[42rem] items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.04] px-3 py-2 text-sm text-muted-foreground">
    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
    <span className="shrink-0 font-medium text-foreground">{imageGenerationStatusLabel(card.status)}</span>
    <span className="min-w-0 flex-1 truncate" title={card.prompt}>{card.prompt}</span>
    <span className={cn('shrink-0 text-xs tabular-nums text-muted-foreground/75')}>{kind} · {card.size} · {formatElapsed(card, now)}</span>
  </div>
}
