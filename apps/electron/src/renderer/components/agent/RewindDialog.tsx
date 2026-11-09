import * as React from 'react'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import type { RewindMode, RewindPlan, RewindResult, RewindTarget } from '@profer/shared'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@profer/ui/primitives/dialog'
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

/**
 * 主路径只保留一次确认（设计 §8）。
 *
 * 刻意不提供「只回退对话 / 只恢复文件 / 同时回退」的选择：用户要的是「回到那一刻」，
 * 该不该动文件是产品判断，不该让用户去选。也不显示 UUID、版本号、文件清单和冲突选项——
 * 那些是内部状态，看到只会让人犹豫。
 */
export function getRewindConfirmCopy(intent: RewindDialogIntent): {
  title: string
  description: string
  submitLabel: string
} {
  const submitLabel = intent === 'regenerate' ? '回退并重新生成' : intent === 'edit-resend' ? '回退并重发' : '回退'
  return {
    title: '确认回退？',
    description: '对话回到这一点，Agent 在这之后改过的文件也一起撤销。你自己后来改过的内容会保留。',
    submitLabel,
  }
}

/**
 * 先按「对话 + 文件」准备；文件回退不可用时（该会话还没记录过文件变化、工作区没接底座）
 * 自动降级成只回退对话。降级是静默的：让用户为「为什么文件回不去」做选择没有意义。
 */
async function prepareWithFallback(
  coordinator: RewindRequestCoordinator,
  client: RewindClient,
  input: { sessionId: string; target: RewindTarget },
): Promise<{ plan: RewindPlan; mode: RewindMode }> {
  const both = coordinator.prepare(createRewindClient(client), { ...input, mode: 'both' })
  if (!both) throw new Error('回退请求未发出')
  try {
    const response = await both
    return { plan: response.plan, mode: 'both' }
  } catch (error) {
    const conversation = coordinator.prepare(createRewindClient(client), { ...input, mode: 'conversation' })
    if (!conversation) throw error
    const response = await conversation
    return { plan: response.plan, mode: 'conversation' }
  }
}

function resultSummary(result: RewindResult): string {
  const files = result.files
  if (!files) return '回退完成。'
  if (files.conflicts.length > 0) {
    return `回退完成。${files.conflicts.length} 个文件保留了你后来的修改，其余已撤销。`
  }
  if (files.restored.length + files.deleted.length === 0) return '回退完成，没有需要撤销的文件修改。'
  return '回退完成。'
}

export function RewindDialog({ open, onOpenChange, sessionId, target, client, intent = 'rewind', draft, onCommitted, onError }: RewindDialogProps): React.ReactElement {
  const [plan, setPlan] = React.useState<RewindPlan | null>(null)
  const [mode, setMode] = React.useState<RewindMode>('both')
  const [result, setResult] = React.useState<RewindResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<Error | null>(null)
  const coordinator = React.useRef(new RewindRequestCoordinator()).current
  const copy = getRewindConfirmCopy(intent)

  // 打开即准备：没有「生成预览」这一步，确认框里直接给结论和按钮。
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setPlan(null)
    setResult(null)
    setError(null)
    setLoading(true)
    void prepareWithFallback(coordinator, client, { sessionId, target })
      .then((prepared) => {
        if (cancelled) return
        setPlan(prepared.plan)
        setMode(prepared.mode)
      })
      .catch((cause) => {
        if (cancelled) return
        const nextError = asRewindError(cause)
        setError(nextError)
        onError?.(nextError)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, coordinator, onError, open, sessionId, target])

  const execute = React.useCallback(() => {
    if (!plan || loading) return
    setLoading(true)
    setError(null)
    const request = coordinator.execute(createRewindClient(client), { sessionId, planId: plan.planId, expectedRevision: plan.revision })
    if (!request) {
      setLoading(false)
      return
    }
    void request
      .then((response) => {
        setResult(response)
        onCommitted?.(response, draft || undefined)
      })
      .catch((cause) => {
        const nextError = asRewindError(cause)
        setError(nextError)
        onError?.(nextError)
      })
      .finally(() => setLoading(false))
  }, [client, coordinator, draft, loading, onCommitted, onError, plan, sessionId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(440px,calc(100vw-2rem))] gap-3 p-4 sm:p-5" aria-describedby="rewind-dialog-description">
        <DialogTitle className="flex items-center gap-2 text-base">
          <RotateCcw className="size-4" />
          {copy.title}
        </DialogTitle>
        <DialogDescription id="rewind-dialog-description" className="text-xs leading-relaxed">
          {copy.description}
        </DialogDescription>
        {draft && (
          <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
            <div className="font-medium">将保留编辑草稿</div>
            <div className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">{draft}</div>
          </div>
        )}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" />
            {plan ? '正在回退…' : '正在检查…'}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{error.message}</span>
          </div>
        )}
        {result && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs">{resultSummary(result)}</div>
        )}
        {!loading && plan && mode === 'conversation' && !result && (
          <div className="text-xs text-muted-foreground">本次只回退对话，文件保持不变。</div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <button type="button" className="h-8 rounded-md px-3 text-xs hover:bg-accent" disabled={loading} onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            type="button"
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!plan || loading}
            onClick={execute}
          >
            {loading && <Loader2 className="mr-1.5 inline size-3 animate-spin" />}
            {copy.submitLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
