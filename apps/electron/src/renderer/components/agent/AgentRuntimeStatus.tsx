import * as React from 'react'
import { Spinner } from '@profer/ui/primitives/spinner'
import { cn } from '@/lib/utils'
import type { AgentRuntimeDisplay } from '@/domains/agent-runtime/agent-runtime-display-policy'

/** 一条活跃状态行；长文案可折行，不改变消息分组与滚动容器。 */
export function AgentRuntimeStatus({ display }: { display: AgentRuntimeDisplay }): React.ReactElement | null {
  if (!display.label) return null
  // interrupted 是“输出异常但运行未结束”，属于需要用户注意的异常停留，用红色区别于普通的等待文案。
  const interrupted = display.kind === 'interrupted'
  return <div className="flex min-h-[28px] min-w-0 items-center gap-2" data-runtime-status={display.kind} role="status">
    <Spinner size="sm" aria-hidden="true" className={cn('shrink-0', interrupted ? 'text-destructive' : 'text-muted-foreground/60')} />
    <span className={cn('min-w-0 break-words text-[13px] font-light', interrupted ? 'text-destructive/90' : 'text-muted-foreground/75')}>{display.label}</span>
  </div>
}
