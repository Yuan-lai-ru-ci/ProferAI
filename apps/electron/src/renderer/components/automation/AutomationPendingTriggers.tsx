import * as React from 'react'
import type { AutomationPendingTrigger } from '@profer/shared'

const statusLabels: Record<AutomationPendingTrigger['status'], string> = {
  queued: '排队中',
  blocked: '受阻',
  running: '执行中',
  interrupted: '已中断',
}

const defaultReasons: Record<AutomationPendingTrigger['status'], string> = {
  queued: '等待可用会话与执行权，任务将保留在队列中。',
  blocked: '暂时无法执行，请检查任务配置与目标会话。',
  running: '正在执行，结束后记录结果。',
  interrupted: '上次执行已中断，为避免重复执行，未自动重放。',
}

/** 使用 LIST 返回的运行态投影；不持有或修改 trigger 事实。 */
export function AutomationPendingTriggers({ triggers, formatTime, onOpenSession }: {
  triggers?: readonly AutomationPendingTrigger[]
  formatTime: (value: number) => string
  onOpenSession: (sessionId: string) => void
}): React.ReactElement | null {
  if (!triggers?.length) return null
  return (
    <section aria-label="待执行与异常" className="flex min-w-0 flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">待执行与异常</span>
        <span className="tabular-nums text-muted-foreground">{triggers.length} 条</span>
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {triggers.map((trigger) => {
          const sessionId = trigger.targetSessionId ?? trigger.boundSessionId
          const needsAttention = trigger.status === 'blocked' || trigger.status === 'interrupted'
          return (
            <li key={trigger.triggerId} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-foreground/[0.03] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className={needsAttention ? 'text-amber-700 dark:text-amber-400' : 'text-foreground/80'}>{statusLabels[trigger.status]}</span>
                <time dateTime={new Date(trigger.scheduledAt).toISOString()} className="min-w-0 text-right tabular-nums text-muted-foreground">{formatTime(trigger.scheduledAt)}</time>
              </div>
              <p className="break-words leading-relaxed text-muted-foreground">{trigger.error || defaultReasons[trigger.status]}</p>
              {sessionId && (
                <button
                  type="button"
                  onClick={() => onOpenSession(sessionId)}
                  className="self-start rounded-md px-1.5 py-1 -ml-1.5 text-xs text-primary transition-colors hover:bg-foreground/[0.04]"
                >
                  查看目标会话
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
