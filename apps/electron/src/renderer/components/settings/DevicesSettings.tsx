/**
 * DevicesSettings — 登录设备管理
 *
 * 列出当前账号已登录的设备，可远程登出某台以腾出设备名额。
 * 数据走主进程 IPC（用 accessToken 打 /v1/auth/devices，避免代管模式下 relay 令牌无法通过 JWT 鉴权）。
 */
import * as React from 'react'
import { Monitor, Loader2, LogOut, RefreshCw, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard } from './primitives'
import { Alert, AlertDescription } from '@/components/ui/alert'

type DeviceRow = {
  id: string
  deviceId: string | null
  deviceName: string
  platform: string | null
  appVersion?: string | null
  createdAt: number
  lastUsedAt: number
}

function platformLabel(p: string | null): string {
  switch (p) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
    default: return p || '未知平台'
  }
}

export function DevicesSettings(): React.ReactElement {
  const [loading, setLoading] = React.useState(true)
  const [devices, setDevices] = React.useState<DeviceRow[]>([])
  const [currentDeviceId, setCurrentDeviceId] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [revoking, setRevoking] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.electronAPI.auth.listDevices()
      if (res.ok) {
        setDevices(res.devices || [])
        setCurrentDeviceId(res.currentDeviceId || null)
      } else {
        setError(res.error || '加载失败')
      }
    } catch {
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const handleRevoke = React.useCallback(async (slotId: string) => {
    setRevoking(slotId)
    try {
      const res = await window.electronAPI.auth.revokeDevice(slotId)
      if (res.ok) {
        setDevices((prev) => prev.filter((d) => d.id !== slotId))
      } else {
        setError(res.error || '登出失败')
      }
    } catch {
      setError('登出失败')
    } finally {
      setRevoking(null)
    }
  }, [])

  return (
    <div>
      <SettingsSection
        title="登录设备"
        description="管理此账号已登录的设备。达到设备上限时，可在这里登出不再使用的设备以腾出名额。"
      >
        <SettingsCard>
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground gap-2">
              <Loader2 size={16} className="animate-spin" /> 加载中...
            </div>
          ) : error ? (
            <div className="flex flex-col gap-3 p-1">
              <Alert variant="destructive">
                <AlertCircle size={16} />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <Button variant="outline" size="sm" onClick={load} className="self-start">
                <RefreshCw size={14} className="mr-1.5" /> 重试
              </Button>
            </div>
          ) : devices.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">暂无登录设备</div>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              {devices.map((d) => {
                const isCurrent = !!d.deviceId && d.deviceId === currentDeviceId
                return (
                  <div key={d.id} className="flex items-center gap-3 p-3 rounded-lg border border-border">
                    <Monitor size={18} className="text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        {d.deviceName}
                        {isCurrent && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">本机</span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {platformLabel(d.platform)}{d.appVersion ? ` · v${d.appVersion}` : ''} · 最近活跃 {new Date(d.lastUsedAt).toLocaleString()}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isCurrent || revoking !== null}
                      onClick={() => handleRevoke(d.id)}
                      title={isCurrent ? '当前设备请使用「退出登录」' : '登出该设备'}
                    >
                      {revoking === d.id
                        ? <Loader2 size={14} className="animate-spin" />
                        : <LogOut size={14} />}
                      <span className="ml-1">登出</span>
                    </Button>
                  </div>
                )
              })}
              <Button variant="ghost" size="sm" onClick={load} className="self-start mt-1">
                <RefreshCw size={14} className="mr-1.5" /> 刷新
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
