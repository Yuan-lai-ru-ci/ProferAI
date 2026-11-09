import * as React from 'react'
import { GitBranch } from 'lucide-react'
import { Spinner } from '@profer/ui/primitives/spinner'
import { cn } from '@/lib/utils'
import {
  formatDelegationElapsed,
  type DelegationRuntimeDisplay,
} from '@/domains/agent-runtime/delegation-runtime-display'

/** 每秒刷新一次的运行计时；不可见或没有起点时不启动定时器。 */
function DelegationElapsed({ startedAt, className }: { startedAt: number; className?: string }): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return (
    <span
      className={cn('tabular-nums text-muted-foreground/70', className)}
      // 计时每秒变化，不参与朗读，避免读屏器被数字刷屏。
      aria-hidden="true"
      data-delegation-elapsed={Math.max(0, Math.floor((now - startedAt) / 1000))}
    >
      · {formatDelegationElapsed(now - startedAt)}
    </span>
  )
}

/**
 * 委派子会话的运行状态条。
 *
 * 子会话页与普通会话共用 AgentMessages：普通会话靠流式状态里的运行计时行表示“在跑”，
 * 但子会话页常常在运行中途才被打开，过程区又默认折叠，运行态很容易完全看不出来。
 * 这里在会话头部固定一条轻量状态行，让“是否在运行”不依赖滚动位置与过程折叠。
 */
export function DelegationRuntimeBar({ display }: { display: DelegationRuntimeDisplay }): React.ReactElement | null {
  if (!display.visible) return null

  const running = display.phase === 'running'
  // 中断与完成、取消必须区分开：它停在断点、等用户决定续跑还是放弃，用红色占位。
  const interrupted = display.phase === 'interrupted'

  return (
    <div
      className="flex min-w-0 items-center gap-2 px-1 py-1 text-[12px]"
      role="status"
      data-delegation-runtime={display.phase}
      data-delegation-runtime-live={display.live ? 'true' : 'false'}
    >
      {running
        ? <Spinner size="sm" aria-hidden="true" className="shrink-0 text-primary/70" />
        : <GitBranch className={cn('size-3 shrink-0', interrupted ? 'text-destructive' : 'text-muted-foreground/45')} aria-hidden="true" />}
      <span className={cn('min-w-0 truncate', interrupted ? 'text-destructive/90' : 'text-muted-foreground/75')}>{display.label}</span>
      {running && display.startedAt != null && <DelegationElapsed startedAt={display.startedAt} />}
    </div>
  )
}
