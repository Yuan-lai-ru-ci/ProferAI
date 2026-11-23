import * as React from 'react'
import { FileQuestion } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import type { SkillCardReminderDecision, SkillCardReminderTarget } from '@profer/shared'

interface Candidate {
  key: string
  name: string
  target: SkillCardReminderTarget
}

interface Props {
  candidates: readonly Candidate[]
  onResolved: () => void
}

export function SkillCardReminder({ candidates, onResolved }: Props): React.ReactElement | null {
  const [pending, setPending] = React.useState<SkillCardReminderDecision | null>(null)
  const [resolved, setResolved] = React.useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = React.useState<{ key: string; message: string } | null>(null)
  const remaining = candidates.filter(item => !resolved.has(item.key))
  const candidate = remaining[0]

  // 本地先移除已回答项，等待列表刷新；之后若卡片被移除，可再次提示。
  React.useEffect(() => {
    setResolved(previous => {
      const next = new Set(candidates.filter(item => previous.has(item.key)).map(item => item.key))
      return next.size === previous.size ? previous : next
    })
  }, [candidates])
  if (!candidate) return null

  async function respond(item: Candidate, decision: SkillCardReminderDecision): Promise<void> {
    if (pending) return
    setPending(decision)
    setError(null)
    try {
      await window.electronAPI.resolveSkillCardReminder(item.target, decision)
      setResolved(previous => new Set(previous).add(item.key))
      onResolved()
      if (decision === 'create') toast.success('已创建路由卡片')
    } catch (cause) {
      setError({ key: item.key, message: cause instanceof Error ? cause.message : '未能保存选择，请重试。' })
    } finally {
      setPending(null)
    }
  }

  return (
    <section aria-label="路由卡片提醒" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_17rem] items-start gap-3" role="status">
        <FileQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="break-words text-sm font-medium">为「{candidate.name}」创建路由卡片？</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            卡片可声明必需的工具、MCP 与能力，也可以限制为手动点名。默认卡不改变现有行为。{remaining.length > 1 && ` 另有 ${remaining.length - 1} 个待处理。`}
          </p>
          {error?.key === candidate.key && <p role="alert" className="break-words text-xs text-destructive">{error.message}</p>}
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={pending !== null} onClick={() => void respond(candidate, 'dismiss')}>
          {pending === 'dismiss' ? '保存中…' : '不再询问'}
        </Button>
        <Button type="button" size="sm" disabled={pending !== null} onClick={() => void respond(candidate, 'create')}>
          {pending === 'create' ? '创建中…' : '创建卡片'}
        </Button>
      </div>
    </section>
  )
}
