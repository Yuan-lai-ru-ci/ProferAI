import * as React from 'react'
import { Download, ImageIcon, Loader2, RefreshCw, XCircle } from 'lucide-react'
import type { AgentImageGenerationCard } from '@profer/shared'
import { Button } from '@/components/ui/button'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { cn } from '@/lib/utils'

export function imageGenerationStatusLabel(status: AgentImageGenerationCard['status']): string {
  return { requesting: '正在请求图片服务', saving: '正在保存图片', succeeded: '已生成', failed: '生成失败' }[status]
}

export function canRetryImageGeneration(card: AgentImageGenerationCard): boolean {
  return card.status === 'failed' && card.reference.kind !== 'paths'
}

function formatElapsed(card: AgentImageGenerationCard, now: number): string {
  const end = card.completedAt ?? now
  const seconds = Math.max(0, Math.floor((end - card.createdAt) / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`
}

export function AgentImageGenerationCardView({
  card,
  onRetry,
}: {
  card: AgentImageGenerationCard
  onRetry?: (generationId: string) => Promise<void>
}): React.ReactElement {
  const [now, setNow] = React.useState(Date.now())
  const [retrying, setRetrying] = React.useState(false)
  const [retryError, setRetryError] = React.useState<string | null>(null)
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  React.useEffect(() => {
    if (card.status === 'succeeded' || card.status === 'failed') return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [card.status])
  React.useEffect(() => {
    if (!card.image) { setImageSrc(null); return }
    window.electronAPI.readAttachment(card.image.localPath)
      .then((base64) => setImageSrc(`data:${card.image!.mediaType};base64,${base64}`))
      .catch(() => setImageSrc(null))
  }, [card.image?.localPath, card.image?.mediaType])
  const retry = async (): Promise<void> => {
    if (!onRetry || retrying) return
    setRetrying(true); setRetryError(null)
    try { await onRetry(card.id) } catch (error) { setRetryError(error instanceof Error ? error.message : '重试请求失败') } finally { setRetrying(false) }
  }
  const pending = card.status === 'requesting' || card.status === 'saving'
  const kind = card.reference.kind === 'last_generated' ? '编辑上一张生成图' : card.reference.kind === 'paths' ? '参考图编辑' : '文本生图'
  return <div className="mx-1 my-3 rounded-xl border border-border/70 bg-card/70 p-3 shadow-sm">
    <div className="flex items-center gap-2 text-sm font-medium">
      {pending ? <Loader2 className="size-4 animate-spin text-primary" /> : card.status === 'failed' ? <XCircle className="size-4 text-destructive" /> : <ImageIcon className="size-4 text-primary" />}
      <span>{imageGenerationStatusLabel(card.status)}</span>
      <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{formatElapsed(card, now)}</span>
    </div>
    <div className="mt-2 flex gap-3">
      {card.status === 'succeeded' && card.image && (imageSrc
        ? <><img className="size-20 cursor-pointer rounded-md border object-cover" src={imageSrc} alt={card.prompt} onClick={() => setLightboxOpen(true)} /><ImageLightbox src={imageSrc} alt={card.image.filename} open={lightboxOpen} onOpenChange={setLightboxOpen} onSave={() => window.electronAPI.saveImageAs(card.image!.localPath, card.image!.filename)} /></>
        : <div className="size-20 animate-pulse rounded-md border bg-muted/40" />)}
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">
        <p className="line-clamp-3 text-foreground/90">{card.prompt}</p>
        <p className="mt-1">{kind} · {card.size} · {card.quality}</p>
        {card.mode === 'official' && card.chargedCredits === 5 && <p className="mt-1 text-primary">已扣 5 积分</p>}
        {card.status === 'failed' && <p className="mt-1 text-destructive">{card.error ?? '图片生成失败'}</p>}
        {card.status === 'failed' && card.reference.kind === 'paths' && <p className="mt-1">请让 Agent 重新选择参考图。</p>}
        {retryError && <p className="mt-1 text-destructive">{retryError}</p>}
      </div>
    </div>
    {card.status === 'succeeded' && card.image && <div className="mt-2 flex justify-end"><Button variant="ghost" size="sm" onClick={() => window.electronAPI.saveImageAs(card.image!.localPath, card.image!.filename)}><Download className="mr-1 size-3.5" />保存图片</Button></div>}
    {canRetryImageGeneration(card) && onRetry && <div className="mt-2 flex justify-end"><Button variant="outline" size="sm" disabled={retrying} title="官方模式重试成功后可能扣除 5 积分" onClick={() => void retry()}><RefreshCw className={cn('mr-1 size-3.5', retrying && 'animate-spin')} />重试生成</Button></div>}
  </div>
}
