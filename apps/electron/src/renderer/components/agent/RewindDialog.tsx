import * as React from 'react'
import { AlertTriangle, FileText, Loader2, RotateCcw } from 'lucide-react'
import type { RewindMode, RewindPlan, RewindResult, RewindTarget } from '@profer/shared'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@profer/ui/primitives/dialog'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { cn } from '@/lib/utils'
import { asRewindError, createRewindClient, RewindRequestCoordinator, type RewindClient } from '@/lib/agent-rewind-client'

export type RewindDialogIntent = 'rewind' | 'regenerate' | 'edit-resend'

export interface RewindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  target: RewindTarget
  client: RewindClient
  intent?: RewindDialogIntent
  draft?: string
  onCommitted?: (result: RewindResult, draft?: string) => void
  onError?: (error: Error) => void
}

const modeLabels: Record<RewindMode, { label: string; description: string }> = {
  conversation: { label: '只回退对话', description: '移出目标之后的消息，不修改工作文件。' },
  files: { label: '只恢复文件', description: '当前版本暂未开放文件写盘，先展示可恢复清单。' },
  both: { label: '同时回退对话和文件', description: '需要 D4/D6 文件执行器接入后才会写盘。' },
}

export interface RewindDialogModeOption {
  mode: RewindMode
  label: string
  description: string
  disabled: boolean
}

export function getRewindDialogModeOptions(intent: RewindDialogIntent): RewindDialogModeOption[] {
  return (Object.keys(modeLabels) as RewindMode[]).map((mode) => ({
    mode,
    ...modeLabels[mode],
    disabled: mode !== 'conversation' && intent !== 'rewind',
  }))
}

function targetLabel(target: RewindTarget): string {
  if (target.kind === 'session-start') return '会话开始'
  if (target.kind === 'message') return `消息 ${target.messageUuid}`
  return `${target.kind === 'after-turn' ? '轮次结束' : '轮次开始'} ${target.turnId}`
}

export function RewindDialog({ open, onOpenChange, sessionId, target, client, intent = 'rewind', draft, onCommitted, onError }: RewindDialogProps): React.ReactElement {
  const [mode, setMode] = React.useState<RewindMode>('conversation')
  const [plan, setPlan] = React.useState<RewindPlan | null>(null)
  const [result, setResult] = React.useState<RewindResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<Error | null>(null)
  const coordinator = React.useRef(new RewindRequestCoordinator()).current
  const files = plan?.files ?? []
  const fileCapabilityUnavailable = mode !== 'conversation' && plan?.capability.supportsFiles === false

  React.useEffect(() => {
    if (!open) return
    setMode('conversation')
    setPlan(null)
    setResult(null)
    setError(null)
  }, [open, intent, target])

  const prepare = React.useCallback(() => {
    setLoading(true)
    setError(null)
    const request = coordinator.prepare(createRewindClient(client), { sessionId, mode, target })
    if (!request) return
    void request.then((response) => setPlan(response.plan)).catch((cause) => {
      const nextError = asRewindError(cause)
      setError(nextError)
      onError?.(nextError)
    }).finally(() => setLoading(false))
  }, [client, coordinator, mode, onError, sessionId, target])

  const execute = React.useCallback(() => {
    if (!plan || loading || fileCapabilityUnavailable) return
    setLoading(true)
    setError(null)
    const request = coordinator.execute(createRewindClient(client), { sessionId, planId: plan.planId, expectedRevision: plan.revision })
    if (!request) return
    void request.then((response) => {
      setResult(response)
      onCommitted?.(response, draft || undefined)
    }).catch((cause) => {
      const nextError = asRewindError(cause)
      setError(nextError)
      onError?.(nextError)
    }).finally(() => setLoading(false))
  }, [client, coordinator, draft, fileCapabilityUnavailable, loading, onCommitted, onError, plan, sessionId])

  const submitLabel = intent === 'regenerate' ? '回退并重新生成' : intent === 'edit-resend' ? '回退并重发' : '执行回退'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,calc(100vw-2rem))] gap-3 p-4 sm:p-5" aria-describedby="rewind-dialog-description">
        <DialogTitle className="flex items-center gap-2 text-base"><RotateCcw className="size-4" />回退预览</DialogTitle>
        <DialogDescription id="rewind-dialog-description" className="text-xs">目标：{targetLabel(target)}。默认只回退对话，工作文件保持不变。</DialogDescription>
        <fieldset className="grid gap-1.5" aria-label="回退范围">
          <legend className="text-xs font-medium text-foreground">回退范围</legend>
          {getRewindDialogModeOptions(intent).map((option) => {
            const disabled = option.disabled
            return <label key={option.mode} className={`flex cursor-pointer items-start gap-2 rounded-md border border-border/60 p-2 text-xs ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
              <input type="radio" name="rewind-mode" value={option.mode} checked={mode === option.mode} disabled={disabled || loading} onChange={() => { setMode(option.mode); setPlan(null) }} className="mt-0.5 accent-primary" />
              <span className="min-w-0"><span className="block font-medium">{option.label}</span><span className="block break-words text-muted-foreground">{option.description}</span></span>
            </label>
          })}
        </fieldset>
        {draft && <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs"><div className="font-medium">将保留编辑草稿</div><div className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">{draft}</div></div>}
        {!plan && !loading && <button type="button" className="h-8 rounded-md border border-border/70 px-3 text-xs font-medium hover:bg-accent" onClick={prepare}>生成预览</button>}
        {loading && <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Loader2 className="size-3.5 animate-spin" />正在检查回退计划…</div>}
        {error && <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{error.message}</span></div>}
        {plan && !loading && <ScrollRegion className="max-h-52 space-y-2 overflow-y-auto pr-1" aria-label="回退计划详情">
          <div className="grid grid-cols-2 gap-2 text-xs"><div className="rounded-md bg-muted/30 p-2">保留消息 <strong>{plan.conversation ? plan.conversation.removedMessageUuids.length === 0 ? '全部' : `${plan.conversation.removedMessageUuids.length} 条移出` : '不变'}</strong></div><div className="rounded-md bg-muted/30 p-2">计划版本 <strong>{plan.revision.state}</strong></div></div>
          {mode !== 'conversation' && <div className="rounded-md border border-border/60 p-2"><div className="mb-1 flex items-center gap-1 text-xs font-medium"><FileText className="size-3.5" />文件清单</div>{files.length === 0 ? <div className="text-xs text-muted-foreground">暂无可恢复文件</div> : <ul className="space-y-1 text-xs">{files.map((file) => <li key={file.itemId} className="flex min-w-0 justify-between gap-2"><span className="min-w-0 break-all">{file.path}</span><span className="shrink-0 text-muted-foreground">{file.action}</span></li>)}</ul>}</div>}
          {fileCapabilityUnavailable && <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">文件恢复能力不可用。本次不会写入文件，请改选“只回退对话”。</div>}
          {result && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs">回退请求已提交。文件恢复仍需 D4/D6 执行器接入。</div>}
        </ScrollRegion>}
        <DialogFooter className="gap-2 sm:gap-2"><button type="button" className="h-8 rounded-md px-3 text-xs hover:bg-accent" disabled={loading} onClick={() => onOpenChange(false)}>取消</button><button type="button" className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50" disabled={!plan || loading || fileCapabilityUnavailable} onClick={execute}>{loading && <Loader2 className="mr-1.5 inline size-3 animate-spin" />}{submitLabel}</button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
