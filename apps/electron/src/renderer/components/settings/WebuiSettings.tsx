/**
 * WebuiSettings —— 「一个会话 = 一个网页」统一管理面板。
 *
 * 只管理静态页的开关、监听网卡、端口与会话白名单；
 * 会话内容 / 发消息 / goal 全部由网页通过既有 WS 命令访问主进程单写者。
 * WebUI 有自己的端口与凭据：开关、网卡、端口都不影响「移动模式（Pocket）」。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Globe, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { ConfirmDialog } from '@profer/ui/primitives/confirm-dialog'
import { Input } from '@profer/ui/primitives/input'
import { Separator } from '@profer/ui/primitives/separator'
import { SettingsCard, SettingsSection, SettingsSelect, SettingsToggle } from './primitives'
import { IntegrationSettingsFeedback } from './IntegrationSettingsFeedback'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { formatRelativeUpdatedAt } from '@/components/app-shell/left-sidebar/sidebar-utils'
import { cn } from '@/lib/utils'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { buildPublishableSessionGroups } from './webui-session-picker'
import type { WebuiConfigPatch, WebuiNetworkInterface, WebuiStatus } from '../../../types'

const NO_SELECTION = '__none__'
const EMPTY_PUBLISHED: readonly string[] = []

/** 网卡类型的人类可读后缀：选中非局域网网卡时，要让用户当场知道「手机可能到不了」。 */
const NIC_KIND_SUFFIX: Record<WebuiNetworkInterface['kind'], string> = {
  lan: '局域网',
  tunnel: '隧道/VPN · 手机通常不可达',
  virtual: '虚拟网卡',
  'link-local': '未获取到 IP',
  loopback: '仅本机',
}

const activityLabel = (updatedAt: number, now: number): string => {
  const relative = formatRelativeUpdatedAt(updatedAt, now)
  return relative === '刚刚' ? relative : `${relative}前`
}

export function WebuiSettings(): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [status, setStatus] = React.useState<WebuiStatus | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [portInput, setPortInput] = React.useState('')
  const [pendingSession, setPendingSession] = React.useState(NO_SELECTION)
  const [revokeTarget, setRevokeTarget] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [collapsedGroups, setCollapsedGroups] = React.useState<ReadonlySet<string>>(() => new Set())

  /** 设置里的期望端口：0 表示跟随默认，输入框里要显示具体数字才有意义。 */
  const desiredPort = (next: WebuiStatus): number => next.configuredPort || next.defaultPort

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI.getWebuiStatus()
      setStatus(next)
      setPortInput(String(desiredPort(next)))
      setLoadError('')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  const apply = React.useCallback(async (patch: WebuiConfigPatch): Promise<boolean> => {
    setSaving(true)
    try {
      const next = await window.electronAPI.setWebuiConfig(patch)
      setStatus(next)
      setPortInput(String(desiredPort(next)))
      setLoadError('')
      return true
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const published = status?.publishedSessionIds ?? EMPTY_PUBLISHED
  const groups = React.useMemo(
    () => buildPublishableSessionGroups({ sessions, workspaces, publishedIds: published, query }),
    [sessions, workspaces, published, query],
  )

  if (!status) {
    return <IntegrationSettingsFeedback loading={!loadError} message={loadError || '正在加载 Web 会话…'} onRetry={loadError ? () => void refresh() : undefined} />
  }

  const nicOptions = [
    { value: '0.0.0.0', label: '0.0.0.0 · 全部网卡（推荐）' },
    // 隧道/VPN 网卡只对隧道内的设备可达，手机在普通 Wi-Fi 下必然连不上：
    // 不再列出来制造误选；如果它正是当前选中项，保留一项用于显示与切回。
    ...status.interfaces
      .filter((nic) => nic.kind !== 'tunnel' || nic.address === status.bindHost)
      .map((nic) => ({
        value: nic.address,
        label: `${nic.address} · ${nic.name}（${NIC_KIND_SUFFIX[nic.kind]}）`,
      })),
  ]
  const portValid = portInput === '' || (/^\d+$/.test(portInput) && Number(portInput) >= 1024 && Number(portInput) <= 65535)
  const portChanged = portInput !== '' && Number(portInput) !== desiredPort(status)
  const titleOf = (id: string): string => sessions.find((session) => session.id === id)?.title || id
  const currentNic = status.interfaces.find((nic) => nic.address === status.bindHost)
  /** 选中隧道/虚拟/无 IP 的网卡时，手机一定连不上，要当场说清楚而不是等用户猜。 */
  const nicUnreachable = currentNic ? currentNic.kind === 'tunnel' || currentNic.kind === 'virtual' || currentNic.kind === 'link-local' : false
  const canPublish = pendingSession !== NO_SELECTION && !saving
  const now = Date.now()

  const copyText = async (text: string, message: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(message)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <SettingsSection
      title="Web 会话（一个会话一个网页）"
      description="默认关闭、默认不发布任何会话；每个已发布会话对应一个独立网页。"
    >
      {loadError && <IntegrationSettingsFeedback message={loadError} onRetry={() => void refresh()} />}

      <SettingsCard divided>
        <SettingsToggle
          label="启用 Web 会话"
          description="开启后启动 WebUI 自己的监听服务；只有下面已发布的会话才有网页。关闭后所有网页立即不可访问，移动模式不受影响。"
          checked={status.enabled}
          onCheckedChange={(enabled) => { void apply({ enabled }) }}
          disabled={saving}
        />
        <SettingsSelect
          label="监听网卡"
          description="默认仅本机可访问；选「全部网卡」或局域网网卡后，同网段的手机才能连上。切换会重启 WebUI 服务。"
          value={status.bindHost}
          onValueChange={(bindHost) => { void apply({ bindHost }) }}
          options={nicOptions}
          disabled={saving}
        />
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">Web 会话端口</div>
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
        </div>
      </SettingsCard>

      {nicUnreachable && (
        <IntegrationSettingsFeedback
          message={`当前监听的是 ${status.bindHost}（${currentNic ? NIC_KIND_SUFFIX[currentNic.kind] : '未知类型'}）：普通 Wi-Fi 下的手机通常连不上。请改成「0.0.0.0 · 全部网卡」或局域网那张网卡的地址。`}
        />
      )}

      {status.error && <IntegrationSettingsFeedback message={`Web 会话服务异常：${status.error}`} />}
      {!status.assetReady && (
        <IntegrationSettingsFeedback message={`缺少 WebUI 静态产物：请把 profer-pocket/webui/dist 放到 ${status.assetDir}，或设置环境变量 PROFER_WEBUI_DIR。`} />
      )}

      <div className="mt-4" />
      <SettingsCard divided={false}>
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">发布会话</div>
          <p className="m-0 text-xs leading-5 text-muted-foreground">按最近活跃排序；项目可折叠，也可以直接搜标题。</p>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="搜索可发布的会话"
              placeholder="搜索会话标题或项目…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>

          {groups.length === 0 ? (
            <p className="m-0 rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-xs text-muted-foreground">
              {query.trim() ? '没有匹配的会话' : '没有可发布的会话'}
            </p>
          ) : (
            <ScrollRegion className="max-h-64 overflow-y-auto rounded-lg border border-border/40 bg-background/40">
              {groups.map((group) => {
                const expanded = Boolean(query.trim()) || !collapsedGroups.has(group.key)
                return (
                  <div key={group.key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={expanded}
                      className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border/40 bg-muted/80 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground backdrop-blur"
                    >
                      {expanded ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 tabular-nums">{group.sessions.length}</span>
                    </button>
                    {expanded && group.sessions.map((session) => {
                      const selected = pendingSession === session.id
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => setPendingSession(session.id)}
                          aria-pressed={selected}
                          className={cn(
                            'flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                            selected ? 'bg-primary/10' : 'hover:bg-muted/50',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground" title={new Date(session.updatedAt).toLocaleString()}>
                            {activityLabel(session.updatedAt, now)}
                          </span>
                          {selected && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </ScrollRegion>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canPublish}
              onClick={() => {
                // 失败时保留选择：否则用户得重新在几十个会话里再找一次
                void apply({ publishedSessionIds: [...published, pendingSession] })
                  .then((ok) => { if (ok) setPendingSession(NO_SELECTION) })
              }}
            >
              <Plus className="size-3.5" />
              发布
            </Button>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {pendingSession === NO_SELECTION ? '选择一个会话后发布' : `将发布：${titleOf(pendingSession)}`}
            </span>
          </div>
        </div>
      </SettingsCard>

      {published.length > 0 && !status.running && (
        <p className="mb-0 mt-2 px-1 text-xs text-muted-foreground">开启「启用 Web 会话」后，下面的地址才可访问。</p>
      )}

      <div className="mt-4" />
      <SettingsCard divided>
        {published.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">当前 0 个网页。发布会话并启用后，可从浏览器访问。</p>
        ) : published.map((id) => {
          // 服务未运行时 token 不存在，拼出来的「无凭据地址」打不开，不如直接不显示。
          const url = status.running ? status.urls.find((item) => item.sessionId === id)?.url ?? '' : ''
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
                title={status.running ? '在浏览器打开' : '启用 Web 会话后可打开'}
                disabled={!status.running}
                onClick={() => {
                  void window.electronAPI.openWebuiSession(id).catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : '打开失败')
                  })
                }}
              >
                <ExternalLink className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" aria-label={`复制 ${titleOf(id)} 的网页地址`} disabled={!url} onClick={() => void copyText(url, '网页地址已复制')}>
                <Copy className="size-3.5" />
              </Button>
              {/* 停止发布会立刻让已分享的链接 404，和「打开 / 复制」分开权重并二次确认 */}
              <Separator orientation="vertical" className="mx-1 h-4" />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`停止发布 ${titleOf(id)}`}
                title="停止发布（网页立即 404）"
                disabled={saving}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setRevokeTarget(id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )
        })}
      </SettingsCard>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}
        title="停止发布这个网页？"
        description={`「${revokeTarget ? titleOf(revokeTarget) : ''}」的网页会立即 404，已经分享出去的链接将无法访问。移动模式与其它网页不受影响。`}
        confirmLabel="停止发布"
        cancelLabel="取消"
        loading={saving}
        onConfirm={() => {
          if (!revokeTarget) return
          const target = revokeTarget
          void apply({ publishedSessionIds: published.filter((item) => item !== target) })
            .then((ok) => { if (ok) setRevokeTarget(null) })
        }}
      />
    </SettingsSection>
  )
}
