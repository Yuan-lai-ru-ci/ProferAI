import * as React from 'react'
import { Copy, Loader2, Tablet, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'
import type { TabletModeStatus } from '../../../types'

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

/** 局域网平板端的连接与凭据设置。 */
export function TabletModeSettings(): React.ReactElement {
  const [status, setStatus] = React.useState<TabletModeStatus | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<TabletModeStatus | null> => {
    try {
      const next = await window.electronAPI.getTabletModeStatus()
      setStatus(next)
      return next
    } catch (error) {
      console.error('[平板模式] 读取状态失败:', error)
      toast.error('读取平板模式状态失败')
      return null
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

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

  const toggle = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.electronAPI.setTabletModeEnabled(enabled)
      setStatus(next)
      toast.success(enabled ? '平板模式已开启' : '平板模式已关闭')
    } catch (error) {
      console.error('[平板模式] 切换失败:', error)
      toast.error(error instanceof Error ? error.message : '切换平板模式失败')
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  if (!status) {
    return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载平板模式...</div>
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="平板模式（试验版）" description="将 Agent 工作区连接到同一局域网内的平板浏览器。">
        <SettingsCard>
          <SettingsToggle
            label="启用平板连接"
            description="开启后立即启动本机服务，并在下次启动 Profer 时自动恢复。"
            checked={status.enabled}
            onCheckedChange={(enabled) => void toggle(enabled)}
            disabled={saving}
          />
        </SettingsCard>
      </SettingsSection>

      {status.enabled && (
        <SettingsSection
          title="连接信息"
          description={status.running ? '请在平板浏览器打开以下局域网地址，并输入连接 Token。' : '正在启动服务，请稍候...'}
        >
          <SettingsCard divided={false}>
            {status.running && status.lanUrl ? (
              <>
                <ConnectionValue label="平板访问地址" value={status.lanUrl} />
                {status.token && <ConnectionValue label="连接 Token" value={status.token} secret />}
              </>
            ) : (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在监听端口 {status.port}...</div>
            )}
          </SettingsCard>
          <div className="mt-3 flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            <Wifi className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>仅支持同一局域网。Token 等同连接凭据，请勿分享给不受信任的人；关闭开关会立即断开平板连接。</span>
          </div>
        </SettingsSection>
      )}

      <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        <Tablet className="mt-0.5 size-4 shrink-0" />
        <span>这是试验版功能。平板与电脑需连接同一个 Wi‑Fi 或局域网，默认端口为 {status.port}。</span>
      </div>
    </div>
  )
}
