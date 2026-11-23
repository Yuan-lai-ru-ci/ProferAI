import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Check, Copy, Plus } from 'lucide-react'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import { CoreSystemIcon } from '@/components/app-shell/CoreSystemIcon'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@profer/ui/primitives/dialog'
import { Label } from '@profer/ui/primitives/label'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@profer/ui/primitives/alert-dialog'
import type { CoreConnectionState, CoreInvitationResult } from '@/types/core-connection'
import { SettingsRow, SettingsSection, SettingsToggle } from './primitives'

export type CoreConnectionAction =
  | { kind: 'retry' }
  | { kind: 'share'; enabled: boolean }
  | { kind: 'invite'; bindingTtlSeconds?: number }
  | { kind: 'pair'; invitation: string; tunnelUrl?: string }
  | { kind: 'revoke'; id: string }

type ConnectionAPI = Pick<Window['electronAPI'], 'getCoreConnectionState' | 'retryLocalCore' | 'setCoreSharing' | 'createCoreInvitation' | 'pairAndSelectCoreInvitation' | 'revokeCoreBinding'>
interface ActionResult { state?: CoreConnectionState; invitation?: CoreInvitationResult; message: string }

export async function performCoreConnectionAction(api: ConnectionAPI, state: CoreConnectionState, action: CoreConnectionAction): Promise<ActionResult> {
  switch (action.kind) {
    case 'retry': return { state: { ...state, local: await api.retryLocalCore() }, message: '正在重新启动本机 Core。' }
    case 'share': return { state: await api.setCoreSharing(action.enabled), message: action.enabled ? '已允许其他设备连接。' : '已停止共享，现有邀请已清除。' }
    case 'invite': return { invitation: await api.createCoreInvitation(action.bindingTtlSeconds, action.bindingTtlSeconds), message: '邀请已生成。' }
    case 'pair':
      if (action.tunnelUrl) await api.pairAndSelectCoreInvitation(action.invitation.trim(), action.tunnelUrl.trim())
      else await api.pairAndSelectCoreInvitation(action.invitation.trim())
      return { message: '已连接并使用此设备。' }
    case 'revoke': return { state: await api.revokeCoreBinding(action.id), message: '设备授权已移除。' }
  }
}

export function coreConnectionError(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : '操作未完成，请重试。'
}

/** 启动窗口最多等待一分钟；清理时停止计时与后续状态更新。 */
export function pollCoreConnectionState(
  read: () => Promise<CoreConnectionState>,
  update: (state: CoreConnectionState) => void,
  fail: (cause: unknown) => void,
  intervalMs = 1000,
  maxAttempts = 60,
): () => void {
  let cancelled = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout>
  async function tick(): Promise<void> {
    try {
      const next = await read()
      if (cancelled) return
      update(next)
      if (next.local.status !== 'starting') return
      attempts += 1
      if (attempts >= maxAttempts) {
        fail(new Error('Core 启动仍未完成，请重新打开此页查看状态。'))
        return
      }
      timer = setTimeout(() => void tick(), intervalMs)
    } catch (cause) {
      if (!cancelled) fail(cause)
    }
  }
  timer = setTimeout(() => void tick(), intervalMs)
  return () => { cancelled = true; clearTimeout(timer) }
}

interface ViewProps {
  platform?: string
  osId?: string
  state?: CoreConnectionState
  busy: boolean
  error?: string
  message?: string
  feedbackScope?: 'local' | 'pair' | 'invite' | 'bindings'
  invitation?: CoreInvitationResult
  invitationText: string
  onInvitationTextChange: (value: string) => void
  onAction: (action: CoreConnectionAction) => void
  onRetry: () => void
}
const STATUS_LABELS = { starting: '正在启动', running: '运行中', stopped: '已停止', failed: '启动失败' }

/** 仅展示连接地址，不展示 URL 中可能携带的认证信息。 */
export function coreEndpointLabel(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
    return url.origin
  } catch { return undefined }
}

export function isCoreInvitationExpired(invitation: CoreInvitationResult, now = Date.now()): boolean {
  return !Number.isFinite(invitation.expiresAt) || invitation.expiresAt <= now
}

interface InvitationContentProps {
  invitationId: string; ttlSeconds: number; setTtlSeconds: (value: number) => void
  busy: boolean; canShare: boolean; sharing: boolean; onAction: (action: CoreConnectionAction) => void
  invitation?: CoreInvitationResult; expired: boolean; now: number; error?: string
}
export function authorizationExpiryLabel(expiresAt?: number, now = Date.now()): string {
  if (expiresAt === undefined) return '无期限'
  const date = new Date(expiresAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${expiresAt <= now ? '已到期' : '截止'} ${date}`
}

export function coreInvitationRemaining(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60000))
  if (minutes >= 1440) return `${Math.ceil(minutes / 1440)} 天`
  if (minutes >= 60) return `${Math.ceil(minutes / 60)} 小时`
  return `${minutes} 分钟`
}

export async function copyCoreInvitation(invitation: CoreInvitationResult, clipboard: Pick<Clipboard, 'writeText'>, now = Date.now()): Promise<void> {
  if (isCoreInvitationExpired(invitation, now)) throw new Error('邀请已过期')
  await clipboard.writeText(invitation.url)
}

export function CoreInvitationContent({ invitationId, ttlSeconds, setTtlSeconds, busy, canShare, sharing, onAction, invitation, expired, now, error }: InvitationContentProps): React.ReactElement {
  const [unit, setUnit] = React.useState(86400)
  const [copyFeedback, setCopyFeedback] = React.useState<{ url: string; success: boolean }>()
  const [copying, setCopying] = React.useState(false)
  const copyInFlight = React.useRef(false)
  const copied = invitation?.url === copyFeedback?.url && copyFeedback?.success === true
  React.useEffect(() => {
    if (!copyFeedback?.success) return
    const timer = setTimeout(() => setCopyFeedback(undefined), 2000)
    return () => clearTimeout(timer)
  }, [copyFeedback])
  const copy = async (): Promise<void> => {
    if (!invitation || busy || expired || !canShare || !sharing || copyInFlight.current) return
    copyInFlight.current = true
    setCopying(true)
    setCopyFeedback(undefined)
    try {
      await copyCoreInvitation(invitation, navigator.clipboard)
      setCopyFeedback({ url: invitation.url, success: true })
    } catch {
      setCopyFeedback({ url: invitation.url, success: false })
    } finally {
      copyInFlight.current = false
      setCopying(false)
    }
  }
  const valid = Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 2592000
  return <div className="space-y-4">
    <p className="text-xs text-muted-foreground">局域网直连；跨网络需先通过 VPN 或隧道互通。</p>
    <div className="space-y-2">
      <Label htmlFor={`${invitationId}-ttl`}>连接授权时长</Label>
      <div className="flex gap-2">
        <Input id={`${invitationId}-ttl`} type="number" min={60 / unit} max={2592000 / unit} step="any" value={Number.isFinite(ttlSeconds) ? ttlSeconds / unit : ''} disabled={busy} aria-invalid={!valid} onChange={event => setTtlSeconds(event.target.value === '' ? NaN : Number(event.target.value) * unit)} />
        <select aria-label="时长单位" value={unit} disabled={busy} onChange={event => setUnit(Number(event.target.value))} className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring"><option value={60}>分钟</option><option value={3600}>小时</option><option value={86400}>天</option></select>
      </div>
      <div className="flex gap-1">{[[3600, '1小时'], [86400, '1天'], [604800, '7天']].map(([value, label]) => <Button key={value} size="sm" variant={ttlSeconds === value ? 'secondary' : 'ghost'} disabled={busy} onClick={() => setTtlSeconds(Number(value))}>{label}</Button>)}</div>
      {!valid && <p role="alert" className="text-xs text-destructive-text">请输入1分钟至30天的时长（精确到秒）。</p>}
    </div>
    <Button disabled={busy || !canShare || !sharing || !valid} onClick={() => onAction({ kind: 'invite', bindingTtlSeconds: ttlSeconds })}>{busy ? '正在生成…' : invitation ? '重新生成' : '生成邀请'}</Button>
    {error && <p role="alert" className="text-sm text-destructive-text">{error}</p>}
    {invitation && (expired || !canShare || !sharing ? <p role="status" className="text-sm text-muted-foreground">{expired ? '邀请已过期，请重新生成。' : '本机共享不可用。'}</p> : <div className="space-y-2"><Label htmlFor={invitationId}>邀请 Token</Label><div className="flex items-center gap-2"><Input id={invitationId} readOnly value={invitation.url} onFocus={event => event.currentTarget.select()} className="min-w-0 flex-1 select-text font-mono text-xs" /><Button type="button" size="sm" variant="outline" className="shrink-0" disabled={busy || copying} onClick={() => void copy()} aria-label={copied ? '邀请 Token 已复制' : '复制邀请 Token'}>{copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}{copied ? '已复制' : '复制'}</Button></div>{copyFeedback?.url === invitation.url && !copyFeedback.success && <p role="alert" className="text-xs text-destructive-text">复制失败，请重试</p>}<p role="status" aria-live="polite" className="sr-only">{copied ? '邀请 Token 已复制' : ''}</p><p role="status" className="text-xs text-muted-foreground">邀请剩余 {coreInvitationRemaining(invitation.expiresAt, now)}</p></div>)}
  </div>
}

export function CoreTunnelInput({ id, enabled, value, busy, onEnabledChange, onChange }: {
  id: string; enabled: boolean; value: string; busy: boolean
  onEnabledChange(enabled: boolean): void; onChange(value: string): void
}): React.ReactElement {
  return <div className="space-y-2">
    <SettingsToggle label="通过隧道连接" checked={enabled} disabled={busy} onCheckedChange={onEnabledChange} />
    {enabled && <div className="space-y-1">
      <Label htmlFor={id}>隧道地址</Label>
      <Input id={id} type="url" value={value} disabled={busy} onChange={event => onChange(event.target.value)} placeholder="https://127.0.0.1:17788" />
      <p className="text-xs text-muted-foreground">转发到对方共享端口，保留 Core 原始 TLS 证书。</p>
    </div>}
  </div>
}

export function CoreConnectionView({ platform, osId, state, busy, error, message, feedbackScope = 'local', invitation, invitationText, onInvitationTextChange, onAction, onRetry }: ViewProps): React.ReactElement {
  const invitationId = React.useId()
  const [ttlSeconds, setTtlSeconds] = React.useState(86400)
  const [useTunnel, setUseTunnel] = React.useState(false)
  const [tunnelUrl, setTunnelUrl] = React.useState('')
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const canShare = state?.local.status === 'running'
  const endpoints = [...new Set(state?.endpoints.map(coreEndpointLabel).filter((value): value is string => Boolean(value)))]
  const feedback = (scope: ViewProps['feedbackScope']) => feedbackScope === scope && <>
    {error && <p role="alert" className="break-words text-sm text-destructive-text">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </>
  return <div className="space-y-5" aria-busy={busy}>
    <div className="space-y-2 border-b border-border/50 pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <CoreSystemIcon platform={platform} osId={osId} local className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-32 flex-1"><p className="break-words text-sm font-medium">{state?.name || '本机'}</p><p role="status" className="text-xs text-muted-foreground">{state ? STATUS_LABELS[state.local.status] : '正在读取本机 Core 状态…'}</p></div>
        {state && <>
          {(state.local.status === 'failed' || state.local.status === 'stopped') && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction({ kind: 'retry' })}>重新启动</Button>}
          <SettingsToggle label="允许连接" checked={state.sharing} disabled={busy || (!canShare && !state.sharing)} onCheckedChange={enabled => onAction({ kind: 'share', enabled })} />
          <Dialog><DialogTrigger asChild><Button size="sm" variant="outline" disabled={busy || !canShare || !state.sharing}><Plus className="size-3.5" aria-hidden="true" />生成邀请</Button></DialogTrigger><DialogContent className="sm:max-w-sm" aria-describedby={undefined}><DialogHeader><DialogTitle>邀请设备</DialogTitle></DialogHeader><CoreInvitationContent {...{ invitationId, ttlSeconds, setTtlSeconds, busy, canShare, sharing: state.sharing, onAction, invitation, now }} expired={invitation ? isCoreInvitationExpired(invitation, now) : false} error={feedbackScope === 'invite' ? error : undefined} /></DialogContent></Dialog>
        </>}
      </div>
      {state?.local.error && <p role="alert" className="text-sm text-destructive-text">{state.local.error}</p>}
      {feedback('local')}
      {error && feedbackScope === 'local' && <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>重新读取状态</Button>}
      {state && <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer rounded py-1 focus-visible:ring-2 focus-visible:ring-ring">连接详情</summary><div className="space-y-1 py-2">{state.coreId && <p className="break-all select-text">{state.coreId}</p>}{canShare && state.sharing && endpoints.map(endpoint => <p key={endpoint} className="break-all select-text">{endpoint}</p>)}</div></details>}
    </div>
    <div className="space-y-2"><Label htmlFor={`${invitationId}-connect`}>连接设备</Label><div className="flex gap-2"><Input id={`${invitationId}-connect`} className="min-w-0 flex-1" value={invitationText} disabled={busy} onChange={event => onInvitationTextChange(event.target.value)} placeholder="输入邀请 Token" /><Button size="sm" disabled={busy || !invitationText.trim() || (useTunnel && !tunnelUrl.trim())} onClick={() => onAction({ kind: 'pair', invitation: invitationText, ...(useTunnel ? { tunnelUrl: tunnelUrl.trim() } : {}) })}>{busy && feedbackScope === 'pair' ? '连接中…' : '连接'}</Button></div><p className="text-xs text-muted-foreground">局域网／VPN 直连，或使用下方隧道地址；Token 不提供公网中继。</p><CoreTunnelInput id={`${invitationId}-tunnel`} enabled={useTunnel} value={tunnelUrl} busy={busy} onEnabledChange={setUseTunnel} onChange={setTunnelUrl} />{feedback('pair')}</div>
    {state && state.bindings.length > 0 && <SettingsSection title="已授权访问本机">{feedback('bindings')}<div className="divide-y divide-border/50">{state.bindings.map(binding => <SettingsRow key={binding.id} label={binding.name} description={authorizationExpiryLabel(binding.expiresAt, now)}><AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={busy} aria-label={`撤销 ${binding.name} 的授权`}>撤销</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>撤销设备授权？</AlertDialogTitle><AlertDialogDescription>“{binding.name}”将无法继续连接本机。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => onAction({ kind: 'revoke', id: binding.id })}>撤销授权</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></SettingsRow>)}</div></SettingsSection>}
  </div>
}

export function CoreConnectionSettings(): React.ReactElement {
  const targets = useAtomValue(coreTargetsAtom)
  const localTarget = targets.targets.find(target => target.kind === 'local')
  const [state, setState] = React.useState<CoreConnectionState>()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [feedbackScope, setFeedbackScope] = React.useState<ViewProps['feedbackScope']>('local')
  const [invitation, setInvitation] = React.useState<CoreInvitationResult>()
  const [invitationText, setInvitationText] = React.useState('')
  const inFlight = React.useRef(false)

  async function run(action?: CoreConnectionAction): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    setFeedbackScope(action?.kind === 'pair' ? 'pair' : action?.kind === 'invite' ? 'invite' : action?.kind === 'revoke' ? 'bindings' : 'local')
    try {
      if (!action) setState(await window.electronAPI.getCoreConnectionState())
      else if (state) {
        const result = await performCoreConnectionAction(window.electronAPI, state, action)
        if (result.state) setState(result.state)
        if (result.invitation) setInvitation(result.invitation)
        if (action.kind === 'share' && !action.enabled) setInvitation(undefined)
        if (action.kind === 'pair') setInvitationText('')
        setMessage(result.message)
      }
    } catch (cause) {
      setError(coreConnectionError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  React.useEffect(() => { void run() }, [])
  React.useEffect(() => {
    if (state?.local.status !== 'starting') return
    return pollCoreConnectionState(
      () => window.electronAPI.getCoreConnectionState(),
      setState,
      cause => { setFeedbackScope('local'); setError(coreConnectionError(cause)) },
    )
  }, [state?.local.status])
  return <CoreConnectionView platform={localTarget?.platform} osId={localTarget?.osId} state={state} busy={busy} error={error} message={message} feedbackScope={feedbackScope} invitation={invitation} invitationText={invitationText} onInvitationTextChange={setInvitationText} onAction={action => void run(action)} onRetry={() => void run()} />
}
