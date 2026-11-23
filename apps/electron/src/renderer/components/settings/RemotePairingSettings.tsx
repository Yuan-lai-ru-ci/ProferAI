import * as React from 'react'
import { Loader2, RefreshCw, Smartphone, Unplug } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'

type PairingQr = { dataUrl: string; expiresAt: number }
type Binding = { id: string; name: string; createdAt: number }
type PairingApi = Pick<Window['electronAPI'], 'getRemotePairingQr' | 'getRemoteBindings' | 'revokeRemoteBinding'>

export function pairingSecondsRemaining(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export async function revokePairingDevice(api: PairingApi, id: string): Promise<Binding[]> {
  await api.revokeRemoteBinding(id)
  return api.getRemoteBindings()
}

interface PairingViewProps {
  qr: PairingQr | null
  remaining: number
  bindings: Binding[] | null
  busy: boolean
  generating?: boolean
  error: string
  devicesError: string
  large?: boolean
  onRefresh: () => void
  onRetryDevices: () => void
  onRevoke: (binding: Binding) => void
}

export function RemotePairingView({ qr, remaining, bindings, busy, error, devicesError, large, generating = busy, onRefresh, onRetryDevices, onRevoke }: PairingViewProps): React.ReactElement {
  return <div className="min-w-0 space-y-6 px-4 py-4" aria-busy={busy}>
    <div className="flex flex-wrap items-start gap-5 rounded-xl bg-muted/25 p-4">
      <div className={`flex min-w-0 max-w-full shrink-0 flex-col items-center gap-2 rounded-xl bg-muted/60 p-3 ${large ? 'w-80' : 'w-56'}`} aria-label="配对码托盘">
        {qr && remaining > 0 && !generating && !error ? <img src={qr.dataUrl} alt="Pocket 一次性配对二维码" className={`w-full aspect-square max-w-full rounded-lg bg-white p-2`} /> :
          <div className="flex aspect-square w-full max-w-full items-center justify-center rounded-lg bg-background/70 p-5 text-center text-sm text-muted-foreground" role="status">
            {generating ? <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />正在生成配对码…</span> : error ? '配对码暂不可用' : qr ? '二维码已过期' : '正在准备配对码…'}
          </div>}
      </div>
      <div className="min-w-0 flex-1 basis-48 space-y-4 py-1">
        <h3 className="text-sm font-semibold">用 Pocket 扫码</h3>
        {qr && !generating && !error && <p className="text-xs tabular-nums text-muted-foreground">{remaining > 0 ? `配对码 ${remaining} 秒后过期` : '请刷新配对码后重新扫描。'}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button variant="outline" disabled={busy} onClick={onRefresh}><RefreshCw className="size-4" />{error ? '重试生成配对码' : '刷新配对码'}</Button>
      </div>
    </div>
    <section className="space-y-3 border-t border-border/60 pt-4" aria-label="已配对设备">
      <div><h3 className="text-sm font-medium">已配对设备{bindings ? ` · ${bindings.length}` : ''}</h3></div>
      {devicesError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">{devicesError}<Button variant="ghost" size="sm" disabled={busy} onClick={onRetryDevices}>重新读取设备</Button></div>}
      {bindings === null ? <p role="status" className="text-sm text-muted-foreground">正在读取配对设备…</p> : bindings.length === 0 ? <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">暂无配对设备</p> : <ul className="divide-y divide-border/60">{bindings.map((binding) => <li key={binding.id} className="flex items-center gap-3 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50"><Smartphone className="size-4 text-muted-foreground" aria-hidden="true" /></span><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{binding.name}</p><p className="mt-1 text-xs text-muted-foreground">配对于 {new Date(binding.createdAt).toLocaleDateString()}</p></div>
        <Button variant="ghost" size="sm" className="shrink-0" disabled={busy} aria-label={`撤销 ${binding.name} 的配对`} onClick={() => onRevoke(binding)}><Unplug className="size-4" />撤销</Button>
      </li>)}</ul>}
    </section>
  </div>
}

export function RemotePairingSettings({ refreshKey = '', large = false }: { refreshKey?: string; large?: boolean } = {}): React.ReactElement {
  const [qr, setQr] = React.useState<PairingQr | null>(null)
  const [remaining, setRemaining] = React.useState(0)
  const [bindings, setBindings] = React.useState<Binding[] | null>(null)
  const [busy, setBusy] = React.useState(true)
  const [generating, setGenerating] = React.useState(true)
  const [error, setError] = React.useState('')
  const [devicesError, setDevicesError] = React.useState('')
  const [pendingRevoke, setPendingRevoke] = React.useState<Binding | null>(null)
  const [revokeError, setRevokeError] = React.useState('')
  const operation = React.useRef(false)
  const generation = React.useRef(0)
  const readDevices = React.useCallback(async (version: number) => {
    try {
      const next = await window.electronAPI.getRemoteBindings()
      if (version !== generation.current) return
      setBindings(next); setDevicesError('')
    } catch {
      if (version === generation.current) setDevicesError('读取设备失败，已保留上次结果。')
    }
  }, [])
  const refresh = React.useCallback(async () => {
    if (operation.current) return
    operation.current = true
    const version = generation.current
    setBusy(true); setGenerating(true); setError(''); setQr(null)
    try {
      const next = await window.electronAPI.getRemotePairingQr()
      if (version === generation.current) { setQr(next); setRemaining(pairingSecondsRemaining(next.expiresAt)) }
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : '生成配对码失败，请重试。')
    } finally {
      if (version === generation.current) { operation.current = false; setBusy(false); setGenerating(false) }
    }
  }, [])
  React.useEffect(() => {
    void refresh()
    void readDevices(generation.current)
    const timer = window.setInterval(() => { if (!operation.current) void readDevices(generation.current) }, 5000)
    return () => { window.clearInterval(timer); generation.current += 1; operation.current = false }
  }, [refresh, refreshKey, readDevices])
  React.useEffect(() => {
    if (!qr) return
    const update = () => setRemaining(pairingSecondsRemaining(qr.expiresAt))
    update(); const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [qr])
  const revoke = async (): Promise<void> => {
    if (!pendingRevoke || operation.current) return
    operation.current = true; setBusy(true); setRevokeError('')
    // 使撤销前已发出的设备查询失效，避免旧凭据重新出现在列表中。
    const version = ++generation.current
    try {
      const next = await revokePairingDevice(window.electronAPI, pendingRevoke.id)
      if (version === generation.current) { setBindings(next); setDevicesError(''); setPendingRevoke(null) }
    } catch (cause) {
      if (version === generation.current) setRevokeError(cause instanceof Error ? cause.message : '撤销失败，请重试。')
    } finally {
      if (version === generation.current) { operation.current = false; setBusy(false); setGenerating(false) }
    }
  }
  return <>
    <RemotePairingView qr={qr} remaining={remaining} bindings={bindings} busy={busy} generating={generating} error={error} devicesError={devicesError} large={large} onRefresh={() => void refresh()} onRetryDevices={() => void readDevices(generation.current)} onRevoke={(binding) => { setRevokeError(''); setPendingRevoke(binding) }} />
    <AlertDialog open={pendingRevoke !== null} onOpenChange={(open) => { if (!open && !busy) setPendingRevoke(null) }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>撤销设备配对？</AlertDialogTitle><AlertDialogDescription>「{pendingRevoke?.name}」的连接凭据将失效。再次连接需要重新扫码配对。</AlertDialogDescription></AlertDialogHeader>
        {revokeError && <p role="alert" className="text-sm text-destructive">{revokeError}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void revoke() }}>{busy ? '正在撤销…' : '撤销配对'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
