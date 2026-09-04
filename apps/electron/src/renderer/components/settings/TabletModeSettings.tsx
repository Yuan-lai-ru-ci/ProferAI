import * as React from 'react'
import { Copy, Download, Loader2, QrCode, RotateCcw, Save, Tablet, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'
import type { TabletModeStatus } from '../../../types'

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
        <code className={`mt-1 block truncate text-xs text-muted-foreground ${secret ? 'select-all' : ''}`}>{value}</code>
      </div>
      <Button variant="ghost" size="icon" className="shrink-0" onClick={() => void copy()} aria-label={`复制${label}`}>
        <Copy className="size-4" />
      </Button>
    </div>
  )
}

/** 局域网移动端的连接与凭据设置。 */
export function TabletModeSettings(): React.ReactElement {
  const [status, setStatus] = React.useState<TabletModeStatus | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [portInput, setPortInput] = React.useState('')
  const [savingPort, setSavingPort] = React.useState(false)
  /** 用户手动编辑过端口输入后，不再被状态刷新覆盖 */
  const portDirtyRef = React.useRef(false)
  /** 安卓版 APK 扫码下载信息（含二维码 dataURL），服务运行且找到 APK 时存在 */
  const [apkQr, setApkQr] = React.useState<ApkQrInfo | null>(null)
  const [apkLoading, setApkLoading] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<TabletModeStatus | null> => {
    try {
      const next = await window.electronAPI.getTabletModeStatus()
      setStatus(next)
      return next
    } catch (error) {
      console.error('[移动模式] 读取状态失败:', error)
      toast.error('读取移动模式状态失败')
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

  // 服务监听是异步的；启用后短暂轮询，直到主进程回传局域网地址与 Token。
  React.useEffect(() => {
    if (!status?.enabled || status.running) return
    const timer = window.setInterval(() => void refresh(), 500)
    const timeout = window.setTimeout(() => window.clearInterval(timer), 5_000)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(timeout)
    }
  }, [refresh, status?.enabled, status?.running])

  // 拉取安卓版 APK 扫码下载信息（地址 + 二维码，指向官网 profer.cn 域名）。
  // 官网直链随时可用，不依赖移动模式服务是否运行。
  React.useEffect(() => {
    let cancelled = false
    setApkLoading(true)
    void window.electronAPI.getProferApkQr().then((info) => {
      if (cancelled) return
      setApkQr(info)
      setApkLoading(false)
    }).catch(() => {
      if (!cancelled) { setApkQr(null); setApkLoading(false) }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.electronAPI.setTabletModeEnabled(enabled)
      setStatus(next)
      toast.success(enabled ? '移动模式已开启' : '移动模式已关闭')
    } catch (error) {
      console.error('[移动模式] 切换失败:', error)
      toast.error(error instanceof Error ? error.message : '切换移动模式失败')
      await refresh()
    } finally {
      setSaving(false)
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
    if (!portValid) {
      toast.error('端口必须是 1024-65535 之间的整数')
      return
    }
    setSavingPort(true)
    try {
      const wasRunning = status?.running === true
      const next = await window.electronAPI.setTabletModePort(parsedPort)
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
      await refresh()
    } finally {
      setSavingPort(false)
    }
  }

  // 恢复默认端口（正式版 7788 / 开发版 7789）
  const resetPort = async (): Promise<void> => {
    setSavingPort(true)
    try {
      const wasRunning = status?.running === true
      const next = await window.electronAPI.setTabletModePort(0)
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
      await refresh()
    } finally {
      setSavingPort(false)
    }
  }

  if (!status) {
    return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载移动模式...</div>
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="移动模式（试验版）" description="将 Agent 工作区连接到同一局域网内的移动设备浏览器。">
        <SettingsCard divided>
          <SettingsToggle
            label="启用移动端连接"
            description="开启后立即启动本机服务，并在下次启动 Profer 时自动恢复。"
            checked={status.enabled}
            onCheckedChange={(enabled) => void toggle(enabled)}
            disabled={saving}
          />
          {status.error && (
            <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">
              {status.error}
            </div>
          )}
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
            <div className="flex items-center gap-2">
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
                aria-invalid={!portValid && !portEmpty}
                className={`w-32 flex-shrink-0 tabular-nums ${
                  !portValid && !portEmpty ? 'border-destructive focus-visible:ring-destructive/30' : ''
                }`}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!portChanged || savingPort}
                onClick={() => void savePort()}
              >
                {savingPort ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存
              </Button>
              {isCustomPort && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={savingPort}
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

      {status.enabled && (
        <SettingsSection
          title="连接信息"
          description={status.running ? '请在移动设备浏览器打开以下局域网地址，并输入连接 Token。' : '正在启动服务，请稍候...'}
        >
          <SettingsCard divided={false}>
            {status.running && status.lanUrl ? (
              <>
                <ConnectionValue label="移动端访问地址" value={status.lanUrl} />
                {status.token && <ConnectionValue label="连接 Token" value={status.token} secret />}
              </>
            ) : (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在监听端口 {status.port}...</div>
            )}
          </SettingsCard>
          <div className="mt-3 flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            <Wifi className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>仅支持同一局域网。Token 等同连接凭据，请勿分享给不受信任的人；关闭开关会立即断开移动端连接。</span>
          </div>
        </SettingsSection>
      )}

      {/* 安卓版 App 扫码下载：指向官网 profer.cn 域名直链，任何场景都可用，不依赖移动模式是否开启。 */}
      <SettingsSection
        title="下载安卓版 App"
        description="用手机扫码，或点按钮/复制链接到手机浏览器打开，即可下载安装 Profer 移动版（安卓）。"
      >
        <SettingsCard divided={false}>
          <div className="flex items-center gap-5 px-4 py-4">
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              {apkLoading || !apkQr ? (
                <div className="flex size-[104px] items-center justify-center rounded-xl border border-border bg-muted/40">
                  <Loader2 className="size-7 animate-spin text-muted-foreground" />
                </div>
              ) : apkQr.dataUrl ? (
                <img src={apkQr.dataUrl} alt="安卓版 App 下载二维码" className="size-[104px] shrink-0 rounded-xl border border-border" />
              ) : (
                <QrCode className="size-[104px] text-muted-foreground/40" />
              )}
              {apkQr && <span className="px-0.5 text-center text-[11px] leading-4 text-muted-foreground">{apkQr.fileName}</span>}
            </div>
            <div className="min-w-0 flex-1">
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

      <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        <Tablet className="mt-0.5 size-4 shrink-0" />
        <span>这是试验版功能。手机/平板与电脑需连接同一个 Wi‑Fi 或局域网。</span>
      </div>
    </div>
  )
}
