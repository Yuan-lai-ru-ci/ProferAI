import * as React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'

/** 集成设置的读取、保存错误与重试；不把未知状态当成空配置。 */
export function IntegrationSettingsFeedback({ loading = false, message, onRetry }: {
  loading?: boolean
  message: string
  onRetry?: () => void
}): React.ReactElement {
  return (
    <div role={loading ? 'status' : 'alert'} aria-busy={loading} className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 px-4 py-4 text-sm">
      {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <AlertTriangle className="size-4 shrink-0 text-destructive" />}
      <span className="min-w-0 flex-1 break-words text-muted-foreground">{message}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry} disabled={loading}>重试</Button>}
    </div>
  )
}

/** 拒绝重复点击发起同一在途操作，finally 始终释放。 */
export function useIntegrationAction(): { busy: boolean; run: (action: () => Promise<void>) => Promise<void> } {
  const [busy, setBusy] = React.useState(false)
  const pending = React.useRef(false)
  const run = React.useCallback(async (action: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { await action() }
    finally { pending.current = false; setBusy(false) }
  }, [])
  return { busy, run }
}
