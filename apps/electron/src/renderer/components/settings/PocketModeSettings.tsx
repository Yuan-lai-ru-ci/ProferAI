import * as React from 'react'
import { Copy, Download, Loader2, QrCode, RotateCcw, Save, Smartphone, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'
import { RemotePairingSettings } from './RemotePairingSettings'
import type { PocketModeStatus } from '../../../types'
import { IntegrationSettingsFeedback } from './IntegrationSettingsFeedback'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'

/** 安卓版 APK 扫码下载信息 */
interface ApkQrInfo {
  url: string
  dataUrl: string
  fileName: string
}

function ConnectionValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }): React.ReactElement {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label}已复制`)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <code className={`mt-1 block truncate text-xs text-muted-foreground ${secret ? 'select-all' : ''}`}>{secret ? `••••••••${value.slice(-4)}` : value}</code>
      </div>
      <Button variant="ghost" size="icon" className="shrink-0" onClick={() => void copy()} aria-label={`复制${label}`}>
        <Copy className="size-4" />
      </Button>
    </div>
  )
}

export function pocketServiceLabel(status: PocketModeStatus, timedOut = false): string {
  if (!status.enabled) return '未开启'
  if (status.error || timedOut) return '服务未就绪'
  return status.running ? '可供移动端连接' : '正在启动'
}

export function PocketServiceSummary({ status, timedOut = false }: { status: PocketModeStatus; timedOut?: boolean }): React.ReactElement {
  const failed = status.enabled && Boolean(status.error || timedOut)
  const ready = status.enabled && status.running && !failed
  return <div className="flex items-start gap-4 bg-muted/30 px-4 py-5" role="status">
    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background shadow-sm">
      <Smartphone className="size-5 text-muted-foreground" aria-hidden="true" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">移动连接服务</p>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${failed ? 'bg-destructive/10 text-destructive' : ready ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
          <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{pocketServiceLabel(status, timedOut)}
        </span>
      </div>
      {failed && <p className="mt-2 text-xs text-destructive-text">检查端口或重试启动</p>}
    </div>
  </div>
}

/** 局域网移动端的连接与凭据设置。 */
export function PocketModeSettings(): React.ReactElement {
  const [status, setStatus] = React.useState<PocketModeStatus | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [disableOpen, setDisableOpen] = React.useState(false)
  const [listenTimedOut, setListenTimedOut] = React.useState(false)
  const operationPending = React.useRef(false)
  const [saving, setSaving] = React.useState(false)
  const [portInput, setPortInput] = React.useState('')
  const [savingPort, setSavingPort] = React.useState(false)
  /** 用户手动编辑过端口输入后，不再被状态刷新覆盖 */
  const portDirtyRef = React.useRef(false)
  /** 公网连接地址草稿（自建 FRP/端口映射） */
  const [publicHost, setPublicHost] = React.useState('')
  const [publicPort, setPublicPort] = React.useState('')
  const [savingPublic, setSavingPublic] = React.useState(false)
  const publicDirtyRef = React.useRef(false)
  /** 安卓版 APK 扫码下载信息（含二维码 dataURL），服务运行且找到 APK 时存在 */
  const [apkQr, setApkQr] = React.useState<ApkQrInfo | null>(null)
  const [apkLoading, setApkLoading] = React.useState(false)
  const [apkError, setApkError] = React.useState('')
  const [apkAttempt, setApkAttempt] = React.useState(0)

  const refresh = React.useCallback(async (): Promise<PocketModeStatus | null> => {
    setLoadError('')
    try {
      const next = await window.electronAPI.getPocketModeStatus()
      setStatus(next)
      return next
    } catch (error) {
      console.error('[移动模式] 读取状态失败:', error)
      setLoadError('读取移动模式状态失败，请重试。')
      return null
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // 状态就绪后同步端口输入框（用户已编辑时以用户输入为准）
  React.useEffect(() => {
    if (status && !portDirtyRef.current) setPortInput(String(status.port))
  }, [status?.port])

  // 同步已保存的公网地址（用户正在编辑时以草稿为准）
  React.useEffect(() => {
    if (publicDirtyRef.current) return
    setPublicHost(status?.publicEndpoint?.host ?? '')
    setPublicPort(status?.publicEndpoint ? String(status.publicEndpoint.port) : '')
  }, [status?.publicEndpoint?.host, status?.publicEndpoint?.port])

  // 服务监听是异步的；启用后短暂轮询，直到主进程回传局域网地址与 Token。
  React.useEffect(() => {
    if (!status?.enabled || status.running || status.error) return
    setListenTimedOut(false)
    const timer = window.setInterval(() => void refresh(), 500)
    const timeout = window.setTimeout(() => { window.clearInterval(timer); setListenTimedOut(true) }, 5_000)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(timeout)
    }
  }, [refresh, status?.enabled, status?.running, status?.error])

  // 拉取安卓版 APK 扫码下载信息（地址 + 二维码，指向官网 profer.cn 域名）。
  // 官网直链随时可用，不依赖移动模式服务是否运行。
  React.useEffect(() => {
    let cancelled = false
    setApkLoading(true)
    setApkError('')
    void window.electronAPI.getProferApkQr().then((info) => {
      if (cancelled) return
      setApkQr(info)
      if (!info) setApkError('暂未提供安卓版下载信息。')
      setApkLoading(false)
    }).catch(() => {
      if (!cancelled) { setApkQr(null); setApkLoading(false); setApkError('安卓版下载信息加载失败，请重试。') }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apkAttempt])

  const toggle = async (enabled: boolean): Promise<void> => {
    if (operationPending.current) return
    operationPending.current = true
    setSaving(true)
    setActionError('')
    try {
      const next = await window.electronAPI.setPocketModeEnabled(enabled)
      setStatus(next)
      setDisableOpen(false)
      setListenTimedOut(false)
      toast.success(enabled ? '移动模式已开启' : '移动模式已关闭')
    } catch (error) {
      console.error('[移动模式] 切换失败:', error)
      toast.error(error instanceof Error ? error.message : '切换移动模式失败')
      setActionError('切换失败，保留上次读取的状态。请重试。')
      await refresh()
    } finally {
      setSaving(false)
      operationPending.current = false
    }
  }

  // 端口输入校验：1024-65535 的整数（避开系统/特权端口）
  const parsedPort = Number(portInput)
  const portEmpty = portInput.trim() === ''
  const portValid =
    !portEmpty && Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
  const portChanged = portValid && status != null && parsedPort !== status.port
  /** 当前是否使用自定义端口（非默认） */
  const isCustomPort = status != null && status.port !== status.defaultPort

  const savePort = async (): Promise<void> => {
    if (operationPending.current) return
    if (!portValid) {
      toast.error('端口必须是 1024-65535 之间的整数')
      return
    }
    setSavingPort(true)
    operationPending.current = true
    setActionError('')
    try {
      const wasRunning = status?.running === true
      const next = await window.electronAPI.setPocketModePort(parsedPort)
      setStatus(next)
      portDirtyRef.current = false
      setPortInput(String(next.port))
      if (wasRunning && !next.running) {
        toast.warning(`端口 ${parsedPort} 可能被占用，服务重启失败，请换一个端口`)
      } else {
        toast.success(`端口已更新为 ${parsedPort}`)
      }
    } catch (error) {
      console.error('[移动模式] 保存端口失败:', error)
      toast.error(error instanceof Error ? error.message : '保存端口失败')
      setActionError('保存端口失败，端口草稿已保留。请重试保存。')
      await refresh()
    } finally {
      setSavingPort(false)
      operationPending.current = false
    }
  }

  // 恢复默认端口（正式版 7788 / 开发版 7789）
  const resetPort = async (): Promise<void> => {
    if (operationPending.current) return
    setSavingPort(true)
    operationPending.current = true
    setActionError('')
    try {
      const wasRunning = status?.running === true
      const next = await window.electronAPI.setPocketModePort(0)
      setStatus(next)
      portDirtyRef.current = false
      setPortInput(String(next.port))
      if (wasRunning && !next.running) {
        toast.warning(`端口 ${next.port} 可能被占用，服务重启失败`)
      } else {
        toast.success(`已恢复默认端口 ${next.port}`)
      }
    } catch (error) {
      console.error('[移动模式] 恢复默认端口失败:', error)
      toast.error(error instanceof Error ? error.message : '恢复默认端口失败')
      setActionError('恢复默认端口失败，当前端口与草稿已保留。请重试。')
      await refresh()
    } finally {
      setSavingPort(false)
      operationPending.current = false
    }
  }

  // ===== 公网连接地址（自建 FRP / 端口映射）=====
  const parsedPublicPort = Number(publicPort)
  const publicPortValid = publicPort.trim() !== '' && Number.isInteger(parsedPublicPort) && (parsedPublicPort === 443 || (parsedPublicPort >= 1024 && parsedPublicPort <= 65535))
  const publicHostValid = publicHost.trim().length > 0
  const publicEndpoint = status?.publicEndpoint ?? null
  const publicChanged = publicEndpoint
    ? publicEndpoint.host !== publicHost.trim() || publicEndpoint.port !== parsedPublicPort
    : publicHostValid && publicPortValid

  const savePublic = async (): Promise<void> => {
    if (operationPending.current) return
    if (!publicHostValid) { toast.error('请填写公网 IP 或域名'); return }
    if (!publicPortValid) { toast.error('公网端口必须是 443 或 1024-65535 之间的整数'); return }
    setSavingPublic(true)
    operationPending.current = true
    setActionError('')
    try {
      const next = await window.electronAPI.setPocketPublicEndpoint({ host: publicHost.trim(), port: parsedPublicPort })
      setStatus(next)
      publicDirtyRef.current = false
      if (next.publicEndpoint) {
        setPublicHost(next.publicEndpoint.host)
        setPublicPort(String(next.publicEndpoint.port))
      }
      toast.success('公网地址已保存，刷新二维码即带上该地址')
    } catch (error) {
      console.error('[移动模式] 保存公网地址失败:', error)
      toast.error(error instanceof Error ? error.message : '保存公网地址失败')
      setActionError('保存公网地址失败，草稿已保留。请重试保存。')
      await refresh()
    } finally {
      setSavingPublic(false)
      operationPending.current = false
    }
  }

  const clearPublic = async (): Promise<void> => {
    if (operationPending.current) return
    setSavingPublic(true)
    operationPending.current = true
    setActionError('')
    try {
      const next = await window.electronAPI.setPocketPublicEndpoint(null)
      setStatus(next)
      publicDirtyRef.current = false
      setPublicHost('')
      setPublicPort('')
      toast.success('已清除公网地址，二维码只带局域网地址')
    } catch (error) {
      console.error('[移动模式] 清除公网地址失败:', error)
      toast.error(error instanceof Error ? error.message : '清除公网地址失败')
      setActionError('清除公网地址失败。请重试。')
      await refresh()
    } finally {
      setSavingPublic(false)
      operationPending.current = false
    }
  }

  const copyManualInfo = async (): Promise<void> => {
    if (!publicEndpoint) return
    const lines = [
      'Profer 手动连接信息',
      `地址：${publicEndpoint.host}`,
      `端口：${publicEndpoint.port}`,
      ...(status?.token ? [`Token：${status.token}`] : []),
      ...(publicEndpoint.pin ? [`证书指纹：${publicEndpoint.pin}`] : []),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success('连接信息已复制，可在手机「手动连接」里逐项填写')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  if (!status) {
    return <div className="space-y-4 rounded-xl bg-muted/30 p-5" aria-busy={!loadError}>
      <div className="flex items-center gap-3"><div className="flex size-11 items-center justify-center rounded-xl bg-background shadow-sm"><Smartphone className="size-5 text-muted-foreground" aria-hidden="true" /></div><div><h3 className="text-sm font-semibold">移动端连接</h3><p className="mt-1 text-xs text-muted-foreground">本机服务 · Pocket 配对</p></div></div>
      <IntegrationSettingsFeedback loading={!loadError} message={loadError || '正在加载移动模式…'} onRetry={loadError ? () => void refresh() : undefined} />
      {!loadError && <div aria-hidden="true" className="space-y-2"><div className="h-2 w-2/3 rounded-full bg-muted" /><div className="h-2 w-1/3 rounded-full bg-muted" /></div>}
    </div>
  }

  return (
    <div className="min-w-0 space-y-6">
      {loadError && <IntegrationSettingsFeedback message={loadError} onRetry={() => void refresh()} />}
      {actionError && <IntegrationSettingsFeedback message={actionError} />}
      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>关闭移动端连接？</AlertDialogTitle><AlertDialogDescription>当前移动端连接会立即断开。之后可重新开启。</AlertDialogDescription></AlertDialogHeader>
          {actionError && <IntegrationSettingsFeedback message={actionError} />}
          <AlertDialogFooter><AlertDialogCancel disabled={saving}>取消</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void toggle(false) }}>关闭连接</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SettingsSection title="移动端连接">
        <SettingsCard divided>
          <PocketServiceSummary status={status} timedOut={listenTimedOut} />
          <SettingsToggle
            label="启用移动端连接"
            description="随 Profer 自动启动"
            checked={status.enabled}
            onCheckedChange={(enabled) => { if (!enabled) setDisableOpen(true); else void toggle(true) }}
            disabled={saving || savingPort || savingPublic || Boolean(loadError)}
          />
          {status.error && (
            <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">
              {status.error}
            </div>
          )}
          {!status.error && status.notice && (
            <div className="border-t border-border bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
              {status.notice}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {status.enabled && (
        <SettingsSection
          title="设备配对"
          description={status.running ? undefined : status.error || listenTimedOut ? '服务未就绪' : '正在启动…'}
        >
          <SettingsCard divided={false}>
            {status.running ? (
              <>
                <RemotePairingSettings
                  refreshKey={publicEndpoint ? `${publicEndpoint.host}:${publicEndpoint.port}` : 'lan'}
                  large={Boolean(publicEndpoint)}
                />
                <details className="px-4 pb-4">
                  <summary className="cursor-pointer rounded-md py-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">手动连接地址与凭据</summary>
                  {status.lanUrl && <ConnectionValue label="移动端访问地址" value={status.lanUrl} />}
                  {status.token && <ConnectionValue label="连接凭据（请勿外传）" value={status.token} secret />}
                </details>
              </>
            ) : status.error || listenTimedOut ? (
              <IntegrationSettingsFeedback loading={saving} message={status.error || '启动等待已超时，请重试启动或更换端口。'} onRetry={() => void toggle(true)} />
            ) : (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在监听端口 {status.port}...</div>
            )}
          </SettingsCard>

        </SettingsSection>
      )}

      <details className="group min-w-0 rounded-xl bg-muted/20 p-4">
        <summary className="cursor-pointer rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">网络配置 <span className="ml-2 text-xs font-normal text-muted-foreground">端口 {status.port} · {publicEndpoint ? '已配置公网入口' : '仅局域网'}</span></summary>
        <div className="mt-5 space-y-5">
        <SettingsSection title="服务端口" description="更改后将重启服务。">
          <SettingsCard divided={false}>
          <div className="flex flex-col gap-2.5 px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">服务端口</div>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  移动端访问本机的监听端口。被其他程序占用时，可改用其他端口，随时可恢复默认。
                </p>
              </div>
              {isCustomPort && (
                <span className="mt-0.5 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground">
                  自定义端口
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={5}
                placeholder={String(status.defaultPort)}
                value={portInput}
                onChange={(e) => {
                  portDirtyRef.current = true
                  setPortInput(e.target.value.replace(/\D/g, ''))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && portChanged && !savingPort) void savePort()
                }}
                aria-label="移动模式服务端口"
                disabled={saving || savingPort || savingPublic || Boolean(loadError)}
                aria-invalid={!portValid && !portEmpty}
                className={`w-32 flex-shrink-0 tabular-nums ${
                  !portValid && !portEmpty ? 'border-destructive focus-visible:ring-destructive/30' : ''
                }`}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!portChanged || savingPort || saving || savingPublic || Boolean(loadError)}
                onClick={() => void savePort()}
              >
                {savingPort ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存
              </Button>
              {isCustomPort && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={savingPort || saving || savingPublic || Boolean(loadError)}
                  onClick={() => void resetPort()}
                >
                  <RotateCcw className="size-3.5" />
                  恢复默认
                </Button>
              )}
            </div>
            {!portValid && !portEmpty && (
              <p className="text-xs leading-4 text-destructive">端口需为 1024-65535 之间的整数</p>
            )}
            {portValid && !portChanged && !isCustomPort && (
              <p className="text-xs leading-4 text-muted-foreground">使用默认端口 {status.defaultPort}</p>
            )}
          </div>
          </SettingsCard>
        </SettingsSection>
      {/* 公网连接地址：保留自建 FRP / 端口映射与证书信任语义。 */}
      <SettingsSection
        title="公网连接地址（可选）"
        description="自己配置了 FRP 内网穿透时填写。二维码会一并带上公网地址，手机扫码即可在外网连接；不填则只带局域网地址。"
      >
        <SettingsCard divided={false}>
          <div className="flex flex-col gap-2.5 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="公网 IP 或域名"
                placeholder="1.2.3.4 或 remote.example.com"
                autoComplete="off"
                spellCheck={false}
                value={publicHost}
                onChange={(e) => { publicDirtyRef.current = true; setPublicHost(e.target.value) }}
                disabled={saving || savingPort || savingPublic}
                className="w-full min-w-0 sm:w-56"
              />
              <Input
                aria-label="公网端口"
                inputMode="numeric"
                placeholder="17788"
                autoComplete="off"
                maxLength={5}
                value={publicPort}
                onChange={(e) => { publicDirtyRef.current = true; setPublicPort(e.target.value.replace(/\D/g, '')) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && publicChanged && !savingPublic) void savePublic() }}
                disabled={saving || savingPort || savingPublic}
                aria-invalid={publicPort.trim() !== '' && !publicPortValid}
                className="w-24 tabular-nums"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!publicChanged || savingPublic || saving || savingPort}
                onClick={() => void savePublic()}
              >
                {savingPublic ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存
              </Button>
              {publicEndpoint && (
                <Button variant="ghost" size="sm" disabled={savingPublic || saving || savingPort} onClick={() => void clearPublic()}>
                  清除
                </Button>
              )}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              填 IP 时桌面自己提供自签 TLS，二维码带证书指纹；填域名时假定由你自己的反向代理终止 TLS（系统可信证书）。
              两种情况下你的 FRP 都只需把公网端口映射到本机 {status.port} 端口。
            </p>
            {publicEndpoint ? (
              <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 text-xs leading-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="shrink-0 text-muted-foreground">公网地址</span>
                  <code className="min-w-0 break-all">{publicEndpoint.url}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label="复制公网地址"
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(publicEndpoint.url); toast.success('公网地址已复制') } catch { toast.error('复制失败，请手动复制') }
                    }}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                {publicEndpoint.pin && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="shrink-0 text-muted-foreground">证书指纹</span>
                    <code className="min-w-0 break-all">{publicEndpoint.pin}</code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      aria-label="复制证书指纹"
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(publicEndpoint.pin ?? ''); toast.success('证书指纹已复制') } catch { toast.error('复制失败，请手动复制') }
                      }}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                )}
                {publicEndpoint.trustMode === 'pinned' && !publicEndpoint.pin && (
                  <p className="text-destructive">自签证书尚未生成，刷新二维码后会重试。</p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Button variant="outline" size="sm" disabled={!status.token} onClick={() => void copyManualInfo()}>
                    <Copy className="size-3.5" />
                    复制手动连接信息
                  </Button>
                  {!status.token && <span className="text-muted-foreground">开启移动模式后可复制 Token</span>}
                </div>
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">未配置公网地址：二维码只包含局域网地址。</p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

        </div>
      </details>

      <details className="rounded-xl bg-muted/30 p-4">
        <summary className="cursor-pointer rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">还没有 Pocket？下载安卓版 App</summary>
        <div className="mt-4">
      {/* 安卓版 App 扫码下载：指向官网 profer.cn 域名直链，任何场景都可用，不依赖移动模式是否开启。 */}
      <SettingsSection
        title="下载安卓版 App"
        description="用手机扫码，或点按钮/复制链接到手机浏览器打开，即可下载安装 Profer 移动版（安卓）。"
      >
        <SettingsCard divided={false}>
          {apkError && <IntegrationSettingsFeedback message={apkError} onRetry={() => setApkAttempt((previous) => previous + 1)} />}
          <div className="flex flex-wrap items-center gap-5 px-4 py-4">
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              {apkLoading ? (
                <div className="flex size-[104px] items-center justify-center rounded-xl border border-border bg-muted/40">
                  <Loader2 className="size-7 animate-spin text-muted-foreground" />
                </div>
              ) : apkQr?.dataUrl ? (
                <img src={apkQr.dataUrl} alt="安卓版 App 下载二维码" className="size-[104px] shrink-0 rounded-xl border border-border" />
              ) : (
                <QrCode className="size-[104px] text-muted-foreground/40" />
              )}
              {apkQr && <span className="px-0.5 text-center text-[11px] leading-4 text-muted-foreground">{apkQr.fileName}</span>}
            </div>
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-sm text-foreground">Profer 移动版（安卓）</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                在手机上安装后，即可通过远程连接接入电脑上的 Agent。
              </p>
              {apkQr && (
                <a
                  href={apkQr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  <Download className="size-4" />
                  立即下载
                </a>
              )}
              <div className="mt-2.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-0 text-xs text-muted-foreground hover:text-foreground"
                  disabled={apkLoading || !apkQr}
                  onClick={async () => {
                    if (!apkQr) return
                    try {
                      await navigator.clipboard.writeText(apkQr.url)
                      toast.success('官网下载地址已复制，发到手机浏览器打开即可')
                    } catch {
                      toast.error('复制失败，请重试')
                    }
                  }}
                >
                  <Copy className="size-3.5" />
                  复制官网下载地址
                </Button>
              </div>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

        </div>
      </details>

      <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        <Smartphone className="mt-0.5 size-4 shrink-0" />
        <span>这是试验版功能。手机与电脑在同一局域网时可直接扫码；在外网时需先配好公网地址与自己的穿透映射。</span>
      </div>
    </div>
  )
}
