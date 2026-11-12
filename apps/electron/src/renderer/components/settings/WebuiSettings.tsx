/**
 * WebuiSettings —— 「一个会话 = 一个网页」统一管理面板。
 *
 * 只管理静态页的开关、监听网卡、端口与会话白名单；
 * 会话内容 / 发消息 / goal 全部由网页通过既有 WS 命令访问主进程单写者。
 * 与移动模式共用同一个 HTTP/WS 服务，因此端口与运行状态是共享的。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Copy, ExternalLink, Globe, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { SettingsCard, SettingsSection, SettingsSelect, SettingsToggle } from './primitives'
import { IntegrationSettingsFeedback } from './IntegrationSettingsFeedback'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import type { WebuiConfigPatch, WebuiNetworkInterface, WebuiStatus } from '../../../types'

const NO_SELECTION = '__none__'

/** 网卡类型的人类可读后缀：隧道/VPN 网卡是「选错就连不上」的主要来源，必须标注。 */
const NIC_KIND_SUFFIX: Record<WebuiNetworkInterface['kind'], string> = {
  lan: '局域网',
  tunnel: '隧道/VPN · 手机通常不可达',
  virtual: '虚拟网卡',
  'link-local': '未获取到 IP',
  loopback: '仅本机',
}

export function WebuiSettings(): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const [status, setStatus] = React.useState<WebuiStatus | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [portInput, setPortInput] = React.useState('')
  const [pendingSession, setPendingSession] = React.useState(NO_SELECTION)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI.getWebuiStatus()
      setStatus(next)
      setPortInput(String(next.port))
      setLoadError('')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  const apply = React.useCallback(async (patch: WebuiConfigPatch): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.electronAPI.setWebuiConfig(patch)
      setStatus(next)
      setPortInput(String(next.port))
      setLoadError('')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [])

  if (!status) {
    return <IntegrationSettingsFeedback loading={!loadError} message={loadError || '正在加载 Web 会话…'} onRetry={loadError ? () => void refresh() : undefined} />
  }

  const published = status.publishedSessionIds
  const addable = sessions.filter((session) => !published.includes(session.id) && !session.archived)
  const sessionOptions = [
    { value: NO_SELECTION, label: addable.length ? '选择要发布的会话…' : '没有可添加的会话' },
    ...addable.map((session) => ({ value: session.id, label: session.title || session.id })),
  ]
  const nicOptions = [
    { value: '0.0.0.0', label: '0.0.0.0 · 全部网卡（推荐）' },
    ...status.interfaces.map((nic) => ({
      value: nic.address,
      label: `${nic.address} · ${nic.name}（${NIC_KIND_SUFFIX[nic.kind]}）`,
    })),
  ]
  const portValid = portInput === '' || (/^\d+$/.test(portInput) && Number(portInput) >= 1024 && Number(portInput) <= 65535)
  const portChanged = portInput !== '' && Number(portInput) !== status.port
  const titleOf = (id: string): string => sessions.find((session) => session.id === id)?.title || id
  const currentNic = status.interfaces.find((nic) => nic.address === status.bindHost)
  /** 选中隧道/虚拟/无 IP 的网卡时，手机一定连不上，要当场说清楚而不是等用户猜。 */
  const nicUnreachable = currentNic ? currentNic.kind === 'tunnel' || currentNic.kind === 'virtual' || currentNic.kind === 'link-local' : false
  const firewallCommand = `netsh advfirewall firewall add rule name="Profer WebUI ${status.port}" dir=in action=allow protocol=TCP localport=${status.port}`

  const copyText = async (text: string, message: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(message)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  return (
    <SettingsSection
      title="Web 会话（一个会话一个网页）"
      description="默认关闭且不发布任何会话，即默认 0 个网页。与移动模式共用同一个服务与端口。"
    >
      {loadError && <IntegrationSettingsFeedback message={loadError} onRetry={() => void refresh()} />}

      <div className="mb-4 rounded-lg border border-border/40 bg-muted/20 px-4 py-3 text-xs leading-6 text-muted-foreground">
        <div className="font-medium text-foreground">三步开始</div>
        <div>1. 「监听网卡」选「0.0.0.0 · 全部网卡」；只有确定手机走哪张网卡时才选具体那张。</div>
        <div>2. 在下面「发布会话」里选一个会话并点「发布」——每发布一个就多一个网页。</div>
        <div>3. 打开「启用 Web 会话」，等状态显示「服务已运行」，再复制或点「打开」生成的地址。</div>
      </div>

      <SettingsCard divided>
        <SettingsToggle
          label="启用 Web 会话"
          description="开启后启动本机服务；只有下面已发布的会话才有网页。关闭后所有网页立即不可访问。"
          checked={status.enabled}
          onCheckedChange={(enabled) => { void apply({ enabled }) }}
          disabled={saving}
        />
        <SettingsSelect
          label="监听网卡"
          description="默认仅本机可访问。选择局域网网卡时，同网段设备凭地址中的凭据访问，切换后会重启服务。"
          value={status.bindHost}
          onValueChange={(bindHost) => { void apply({ bindHost }) }}
          options={nicOptions}
          disabled={saving}
        />
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">服务端口</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              maxLength={5}
              aria-label="Web 会话服务端口"
              placeholder={String(status.defaultPort)}
              value={portInput}
              onChange={(event) => setPortInput(event.target.value.replace(/\D/g, ''))}
              onKeyDown={(event) => { if (event.key === 'Enter' && portValid && portChanged && !saving) void apply({ port: Number(portInput) }) }}
              disabled={saving}
              aria-invalid={!portValid}
              className="w-32 tabular-nums"
            />
            <Button variant="outline" size="sm" disabled={!portValid || !portChanged || saving} onClick={() => void apply({ port: Number(portInput) })}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
              保存端口
            </Button>
          </div>
          {!portValid && <p className="text-xs leading-4 text-destructive">端口需为 1024-65535 之间的整数</p>}
          <p className="text-xs leading-5 text-muted-foreground">
            此端口与移动模式共用。当前状态：{status.running ? '服务已运行' : '服务未运行'}；静态产物：{status.assetReady ? '已就绪' : '缺失'}。
            {status.bindHost === '0.0.0.0' && (
              <>
                {' '}已监听全部网卡，手机可尝试：
                {status.accessibleHosts.length > 0
                  ? status.accessibleHosts.map((host, index) => (
                      <span key={host}>
                        {index > 0 ? '、' : ''}
                        <code className="font-mono text-foreground">{host}:{status.port}</code>
                      </span>
                    ))
                  : '（未检测到局域网网卡）'}
              </>
            )}
          </p>
        </div>
      </SettingsCard>

      {nicUnreachable && (
        <IntegrationSettingsFeedback
          message={`当前监听的是 ${status.bindHost}（${currentNic ? NIC_KIND_SUFFIX[currentNic.kind] : '未知类型'}）：这个地址只对同一隧道/虚拟网络内的设备可达，手机在普通 Wi-Fi 下必然连不上。请改成「0.0.0.0 · 全部网卡」或局域网那张网卡的地址。`}
        />
      )}
      {status.platform === 'win32' && (
        <div className="mt-3 rounded-lg border border-border/40 bg-muted/20 px-4 py-3 text-xs leading-6 text-muted-foreground">
          <div className="font-medium text-foreground">手机打不开？先看防火墙</div>
          <div>Windows 默认阻止外部访问本机端口。以「管理员身份」打开 PowerShell，粘贴执行下面这条命令放行 {status.port} 端口：</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background/60 px-2 py-1 font-mono text-[11px]">{firewallCommand}</code>
            <Button variant="outline" size="sm" onClick={() => void copyText(firewallCommand, '防火墙放行命令已复制')}>
              <Copy className="size-3.5" />
              复制命令
            </Button>
          </div>
          <div className="mt-2">另外确认手机与电脑连的是同一个 Wi-Fi（同网段），且没有开启「访客网络隔离」。</div>
        </div>
      )}

      {status.serviceError && <IntegrationSettingsFeedback message={`服务异常：${status.serviceError}`} />}
      {!status.assetReady && (
        <IntegrationSettingsFeedback message={`缺少 WebUI 静态产物：请把 profer-pocket/webui/dist 放到 ${status.assetDir}，或设置环境变量 PROFER_WEBUI_DIR。`} />
      )}

      <div className="mt-4" />
      <SettingsCard divided={false}>
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">发布会话</div>
          <p className="text-xs leading-5 text-muted-foreground">每发布一个会话就生成一个独立网页；未发布的会话无法从浏览器访问。</p>
          <div className="flex flex-wrap items-center gap-2">
            <SettingsSelect
              label=""
              value={pendingSession}
              onValueChange={setPendingSession}
              options={sessionOptions}
              disabled={saving || addable.length === 0}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={saving || pendingSession === NO_SELECTION || !published.every((id) => id !== pendingSession)}
              onClick={() => {
                void apply({ publishedSessionIds: [...published, pendingSession] })
                setPendingSession(NO_SELECTION)
              }}
            >
              <Plus className="size-3.5" />
              发布
            </Button>
          </div>
        </div>
      </SettingsCard>

      <div className="mt-4" />
      <SettingsCard divided>
        {published.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">当前 0 个网页。发布会话并启用后，可从浏览器访问。</p>
        ) : published.map((id) => {
          const url = status.urls.find((item) => item.sessionId === id)?.url ?? ''
          return (
            <div key={id} className="flex min-w-0 items-center gap-2 border-b border-border/40 px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{titleOf(id)}</div>
                <code className="mt-1 block truncate text-xs text-muted-foreground">{url || '启用后生成地址'}</code>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`在浏览器打开 ${titleOf(id)}`}
                disabled={!url}
                onClick={() => { if (url) void window.electronAPI.openExternal(url) }}
              >
                <ExternalLink className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" aria-label={`复制 ${titleOf(id)} 的网页地址`} disabled={!url} onClick={() => void copyText(url, '网页地址已复制')}>
                <Copy className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`移除 ${titleOf(id)}`}
                disabled={saving}
                onClick={() => { void apply({ publishedSessionIds: published.filter((item) => item !== id) }) }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )
        })}
      </SettingsCard>
    </SettingsSection>
  )
}
