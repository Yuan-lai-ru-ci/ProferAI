/**
 * ChannelSettings - 渠道配置页
 *
 * 管理所有渠道的添加、编辑、删除与启用状态；每个渠道直接展示可用的 Agent Core。
 * Chat 与 Agent 视觉上统一为一个列表，Agent 兼容性通过内联标签展示。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Plus, Pencil, Trash2, Server, RefreshCw, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { Switch } from '@profer/ui/primitives/switch'
import { PROVIDER_LABELS, isChannelEnabledForRuntime, isAgentEnabledForChannel } from '@profer/shared'
import type { Channel, OfficialChannelHealth, ProviderType } from '@profer/shared'
import { getChannelLogo } from '@/lib/model-logo'
import { resolvePiCoreState } from '@/lib/channel-model-groups'
import { agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom, agentRuntimeAtom } from '@/atoms/agent-atoms'
import { channelsAtom, selectedModelAtom } from '@/atoms/chat-atoms'
import { resolveAgentModelSelection } from '@/lib/agent-channel-selection'
import { authStatusAtom } from '@/atoms/identity-atoms'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import { ChannelForm } from './ChannelForm'
import { ModelAvailabilityBar } from './ModelAvailabilityBar'
import { getOfficialChannelDisplayName, isOfficialChannel, isModelFamilyChannel } from '@/lib/channel-model-groups'
import { aggregateModelHealth } from '@/lib/channel-health-aggregation'

/** 组件视图模式 */
type ViewMode = 'list' | 'create' | 'edit'

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = useAtom(channelsAtom)
  const [officialHealth, setOfficialHealth] = React.useState<OfficialChannelHealth[]>([])
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [editingChannel, setEditingChannel] = React.useState<Channel | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [commercialMode, setCommercialMode] = React.useState(false)
  const [canSelfConfig, setCanSelfConfig] = React.useState(false)
  const [capsReady, setCapsReady] = React.useState(false)
  const [capsError, setCapsError] = React.useState('')
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom)
  const [agentModelId, setAgentModelId] = useAtom(agentModelIdAtom)
  const [agentChannelIds, setAgentChannelIds] = useAtom(agentChannelIdsAtom)
  const authStatus = useAtomValue(authStatusAtom)
  const runtime = useAtomValue(agentRuntimeAtom)
  const [selectedChatModel, setSelectedChatModel] = useAtom(selectedModelAtom)
  const [deleteTarget, setDeleteTarget] = React.useState<Channel | null>(null)
  const [busyIds, setBusyIds] = React.useState<string[]>([])
  const pendingMutations = React.useRef(new Set<string>())
  const requestVersion = React.useRef(0)
  const capsVersion = React.useRef(0)
  const currentAccount = React.useRef(authStatus)
  currentAccount.current = authStatus
  const currentChannels = React.useRef(channels)
  currentChannels.current = channels
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestVersion.current += 1
      capsVersion.current += 1
    }
  }, [])
  const managedFamilyNames = React.useMemo(() => [...new Set(
    channels.filter(isModelFamilyChannel).map((channel) => channel.name.trim()).filter(Boolean),
  )], [channels])
  const managedFamilySummary = managedFamilyNames.length > 0 ? managedFamilyNames.join('、') : '官方'
  const agentChannelIdsRef = React.useRef(agentChannelIds)
  const agentChannelIdRef = React.useRef(agentChannelId)

  React.useEffect(() => {
    agentChannelIdsRef.current = agentChannelIds
  }, [agentChannelIds])

  React.useEffect(() => {
    agentChannelIdRef.current = agentChannelId
  }, [agentChannelId])

  const [refreshingCaps, setRefreshingCaps] = React.useState(false)

  // 加载账号能力（商业模式 + 自配权限）
  const loadCaps = React.useCallback(async (force: boolean) => {
    const version = ++capsVersion.current
    const account = currentAccount.current
    setCapsReady(false)
    setCapsError('')
    try {
      const caps = await window.electronAPI.getAccountCapabilities(force)
      if (version !== capsVersion.current || account !== currentAccount.current) return null
      setCommercialMode(caps.commercialMode)
      setCanSelfConfig(caps.canSelfConfig)
      setCapsReady(true)
      return caps
    } catch {
      if (version === capsVersion.current && account === currentAccount.current) setCapsError('账号权限读取失败，请重试')
      // 不把失败伪装成本地模式；权限未知时禁用自配入口。
      return null
    }
  }, [])

  React.useEffect(() => {
    loadCaps(false).then((caps) => {
      if (caps && caps.commercialMode && !caps.canSelfConfig) loadCaps(true)
    })
  }, [loadCaps, authStatus])

  const handleRefreshCaps = React.useCallback(async () => {
    setRefreshingCaps(true)
    try {
      await loadCaps(true)
    } finally {
      setRefreshingCaps(false)
    }
  }, [loadCaps])

  /** 加载渠道列表（未登录时隐藏服务端托管的官方渠道，避免残留缓存展示给未登录用户） */
  const loadChannels = React.useCallback(async (localOnly = false): Promise<Channel[]> => {
    const version = ++requestVersion.current
    const account = currentAccount.current
    const previousChannels = currentChannels.current
    setLoading(true)
    setLoadError('')
    try {
      const list = await window.electronAPI.listChannels({ localOnly })
      if (version !== requestVersion.current || account !== currentAccount.current) return []
      // 读取期间目录事件可能已提交更新快照，不用旧 LIST 结果覆盖它。
      if (previousChannels !== currentChannels.current) return currentChannels.current
      const visible = account.isLoggedIn ? list : list.filter((c) => !isOfficialChannel(c))
      setChannels(visible)
      return visible
    } catch (error) {
      console.error('[渠道设置] 加载渠道列表失败:', error)
      if (version === requestVersion.current && account === currentAccount.current) setLoadError('模型配置加载失败，当前数据未改变，请重试')
      return []
    } finally {
      if (version === requestVersion.current && account === currentAccount.current) setLoading(false)
    }
  }, [authStatus, setChannels])

  React.useEffect(() => {
    let active = true
    loadChannels()
    if (authStatus.isLoggedIn) {
      window.electronAPI.getOfficialModelHealth().then((health) => { if (active) setOfficialHealth(health) })
        .catch(() => { if (active) setOfficialHealth([]) })
    } else {
      setOfficialHealth([])
    }
    return () => { active = false; requestVersion.current += 1 }
  }, [loadChannels, authStatus.isLoggedIn])

  // 渠道启用/兼容性变化 → 自动同步 Agent 渠道列表
  // 当渠道启用且 provider 兼容 Agent 时，自动纳入 agentChannelIds；
  // 当渠道关闭或不兼容时，自动从 agentChannelIds 移除。
  React.useEffect(() => {
    if (loading || loadError) return
    const derivedIds = channels
      .filter((c) => isAgentEnabledForChannel(c))
      .map((c) => c.id)
    const currentIds = agentChannelIdsRef.current
    const unchanged =
      derivedIds.length === currentIds.length &&
      derivedIds.every((id, index) => id === currentIds[index])
    if (unchanged) return
    agentChannelIdsRef.current = derivedIds
    setAgentChannelIds(derivedIds)
    window.electronAPI.updateSettings({ agentChannelIds: derivedIds }).catch(console.error)
  }, [channels, loading, loadError, setAgentChannelIds])
  React.useEffect(() => {
    if (loading || loadError) return
    const selection = resolveAgentModelSelection(channels, runtime, agentChannelIds,
      agentChannelId && agentModelId ? { channelId: agentChannelId, modelId: agentModelId } : null)
    if (selection?.channelId !== (agentChannelId ?? undefined) || selection?.modelId !== (agentModelId ?? undefined)) {
      setAgentChannelId(selection?.channelId ?? null)
      setAgentModelId(selection?.modelId ?? null)
      void window.electronAPI.updateSettings({ agentChannelId: selection?.channelId, agentModelId: selection?.modelId })
        .catch(() => toast.error('默认模型更新失败，请重新选择'))
    }
    if (selectedChatModel) {
      const selectedChannel = channels.find((channel) => channel.id === selectedChatModel.channelId)
      if (!selectedChannel?.enabled || !selectedChannel.models.some((model) => model.id === selectedChatModel.modelId && model.enabled)) {
        setSelectedChatModel(null)
      }
    }
  }, [channels, loading, loadError, runtime, agentChannelIds, agentChannelId, agentModelId, selectedChatModel, setAgentChannelId, setAgentModelId, setSelectedChatModel])

  // 商业模式且无自配权限时：不允许进入创建/编辑视图
  React.useEffect(() => {
    const locked = !capsReady || (commercialMode && !canSelfConfig)
    if (!locked || viewMode === 'list') return
    setViewMode('list')
    setEditingChannel(null)
  }, [capsReady, commercialMode, canSelfConfig, viewMode])

  const syncAgentChannelEligibility = React.useCallback(async (
    channel: Channel,
    eligible: boolean,
  ): Promise<void> => {
    const currentIds = agentChannelIdsRef.current

    if (eligible) {
      if (currentIds.includes(channel.id)) return
      const newIds = [...currentIds, channel.id]
      agentChannelIdsRef.current = newIds
      setAgentChannelIds(newIds)
      await window.electronAPI.updateSettings({ agentChannelIds: newIds }).catch(console.error)
      return
    }

    if (!currentIds.includes(channel.id)) return
    const newIds = currentIds.filter((id) => id !== channel.id)
    agentChannelIdsRef.current = newIds
    setAgentChannelIds(newIds)

    const updates: Parameters<typeof window.electronAPI.updateSettings>[0] = {
      agentChannelIds: newIds,
    }
    await window.electronAPI.updateSettings(updates).catch(console.error)
  }, [setAgentChannelIds, setAgentChannelId, setAgentModelId])

  /** 删除渠道 */
  const handleDeleteRequest = (channel: Channel): void => {
    setDeleteTarget(channel)
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    if (pendingMutations.current.has(target.id)) return
    pendingMutations.current.add(target.id)
    setBusyIds([...pendingMutations.current])
    const account = currentAccount.current
    try {
      await window.electronAPI.deleteChannel(target.id)
      if (!mounted.current || account !== currentAccount.current) return

      const newIds = agentChannelIds.filter((id) => id !== target.id)
      setAgentChannelIds(newIds)

      setDeleteTarget(null)
      if (agentChannelId === target.id) {
        setAgentChannelId(null)
        setAgentModelId(null)
      }

      await window.electronAPI.updateSettings({
        agentChannelIds: newIds,
        ...(agentChannelId === target.id && { agentChannelId: undefined, agentModelId: undefined }),
      }).catch(() => toast.error('渠道已删除，但默认模型设置保存失败'))

      if (!mounted.current || account !== currentAccount.current) return
      await loadChannels(true)
    } catch (error) {
      console.error('[渠道设置] 删除渠道失败:', error)
      toast.error('渠道删除失败，请重试')
    } finally {
      pendingMutations.current.delete(target.id)
      if (mounted.current) setBusyIds([...pendingMutations.current])
    }
  }

  /** 切换渠道启用状态 — 同时自动同步 Agent 兼容性 */
  const handleToggle = async (channel: Channel): Promise<void> => {
    if (pendingMutations.current.has(channel.id)) return
    pendingMutations.current.add(channel.id)
    setBusyIds([...pendingMutations.current])
    const account = currentAccount.current
    try {
      const savedChannel = await window.electronAPI.updateChannel(channel.id, { enabled: !channel.enabled })
      if (!mounted.current || account !== currentAccount.current) return
      await syncAgentChannelEligibility(
        savedChannel,
        isAgentEnabledForChannel(savedChannel),
      )
      if (!mounted.current || account !== currentAccount.current) return
      await loadChannels(true)
    } catch (error) {
      console.error('[渠道设置] 切换渠道状态失败:', error)
      toast.error('渠道状态保存失败，请重试')
    } finally {
      pendingMutations.current.delete(channel.id)
      if (mounted.current) setBusyIds([...pendingMutations.current])
    }
  }

  /** 表单保存回调 */
  const handleToggleModel = async (channel: Channel, modelId: string): Promise<void> => {
    if (pendingMutations.current.has(channel.id)) return
    pendingMutations.current.add(channel.id)
    setBusyIds([...pendingMutations.current])
    const account = currentAccount.current
    try {
      await window.electronAPI.updateChannel(channel.id, {
        models: channel.models.map((model) => model.id === modelId ? { ...model, enabled: !model.enabled } : model),
      })
      if (!mounted.current || account !== currentAccount.current) return
      await loadChannels(true)
    } catch (error) {
      console.error('[渠道设置] 切换模型状态失败:', error)
      toast.error('模型状态保存失败，请重试')
    } finally {
      pendingMutations.current.delete(channel.id)
      if (mounted.current) setBusyIds([...pendingMutations.current])
    }
  }

  const handleFormSaved = async (): Promise<void> => {
    setViewMode('list')
    setEditingChannel(null)
    await loadChannels()
  }

  /** 取消表单 */
  const handleFormCancel = (): void => {
    setViewMode('list')
    setEditingChannel(null)
  }

  // 表单视图
  if ((viewMode === 'create' || viewMode === 'edit') && capsReady && !(commercialMode && !canSelfConfig)) {
    return (
      <ChannelForm
        channel={editingChannel}
        onSaved={handleFormSaved}
        onAgentEligibilityChange={syncAgentChannelEligibility}
        onCancel={handleFormCancel}
      />
    )
  }

  // 列表视图
  return (
    <div className="space-y-8">
      {capsError && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive">
        <span>{capsError}</span>
        <Button variant="outline" size="sm" disabled={refreshingCaps} onClick={handleRefreshCaps}>
          <RefreshCw size={14} /><span>重试权限</span>
        </Button>
      </div>}
      {/* 模型配置（Chat 与 Agent 统一） */}
      <SettingsSection
        title="模型配置"
        description={
          commercialMode && !canSelfConfig
            ? `${managedFamilySummary}模型池由团队服务器统一管理，无需手动配置；普通/VIP 路由与上游故障转移由后台处理`
            : '管理 AI 供应商连接，配置 API Key 和可用模型。支持 Agent 的渠道会显示对应标签'
        }
        action={
          (commercialMode && !canSelfConfig) ? null : (
            <Button size="sm" disabled={loading || Boolean(loadError) || !capsReady} onClick={() => setViewMode('create')}>
              <Plus size={16} />
              <span>添加配置</span>
            </Button>
          )
        }
      >
        {commercialMode && !canSelfConfig && (
          <SettingsCard>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/10">
              <Server size={18} className="text-primary shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-medium">模型池由服务端统一管理</div>
                <div className="text-xs text-muted-foreground">{managedFamilySummary}模型池由后台按当前账号身份选择普通/VIP 路由，并负责上游主备与故障重试。你当前没有自配 API 权限（可能被管理员单独关闭），如需自行添加 API Key，请联系管理员开通后点「刷新权限」</div>
              </div>
              <Button size="sm" variant="outline" onClick={handleRefreshCaps} disabled={refreshingCaps} className="shrink-0">
                <RefreshCw size={14} className={refreshingCaps ? 'animate-spin' : ''} />
                <span>刷新权限</span>
              </Button>
            </div>
          </SettingsCard>
        )}
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
        ) : loadError ? (
          <SettingsCard divided={false}>
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p role="alert" className="text-sm text-destructive">{loadError}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => { void loadChannels() }}>
                <RefreshCw size={14} />
                <span>重试</span>
              </Button>
            </div>
          </SettingsCard>
        ) : channels.length === 0 ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground py-12 text-center">
              还没有配置任何模型，点击上方"添加配置"开始
            </div>
          </SettingsCard>
        ) : (
          <>
            <SettingsCard>
              {(() => {
                const officialChannels = channels.filter(isOfficialChannel)
                const selfConfiguredChannels = channels.filter((channel) => !isOfficialChannel(channel))
                return <>
                  {groupOfficialChannels(officialChannels).map((group) => <OfficialChannelGroupRow key={`${group.name}:${group.provider}:${group.channels[0]?.familyId ?? ''}`} channels={group.channels} health={officialHealth} isModelFamily={group.isModelFamily} onToggleChannel={handleToggle} onToggleModel={handleToggleModel} />)}
                  {selfConfiguredChannels.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      busy={busyIds.includes(channel.id)}
                      commercialMode={commercialMode}
                      canSelfConfig={capsReady && (!commercialMode || canSelfConfig)}
                      onEdit={() => { setEditingChannel(channel); setViewMode('edit') }}
                      onDelete={() => handleDeleteRequest(channel)}
                      onToggle={() => handleToggle(channel)}
                      health={officialHealth.find((item) => item.channelId === channel.id)}
                    />
                  ))}
                </>
              })()}
            </SettingsCard>
          </>
        )}
      </SettingsSection>

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !pendingMutations.current.has(deleteTarget?.id ?? '')) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定删除渠道？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除渠道「{deleteTarget?.name}」？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deleteTarget && busyIds.includes(deleteTarget.id))} onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={Boolean(deleteTarget && busyIds.includes(deleteTarget.id))} onClick={(event) => { event.preventDefault(); void handleDeleteConfirm() }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface OfficialChannelGroup { name: string; provider: ProviderType; channels: Channel[]; isModelFamily: boolean }

function groupOfficialChannels(channels: Channel[]): OfficialChannelGroup[] {
  const groups = new Map<string, OfficialChannelGroup>()
  for (const channel of channels) {
    const name = channel.name.trim()
    const modelFamily = isModelFamilyChannel(channel)
    const key = modelFamily ? `family:${channel.familyId ?? channel.id}` : `${channel.provider}:${name}`
    const existing = groups.get(key)
    if (existing) existing.channels.push(channel)
    else groups.set(key, { name, provider: channel.provider, channels: [channel], isModelFamily: modelFamily })
  }
  return [...groups.values()]
}

function OfficialChannelGroupRow({ channels, health, isModelFamily, onToggleChannel, onToggleModel }: {
  channels: Channel[]
  health: OfficialChannelHealth[]
  isModelFamily: boolean
  onToggleChannel: (channel: Channel) => Promise<void>
  onToggleModel: (channel: Channel, modelId: string) => Promise<void>
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const runUpdate = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  const representative = channels[0]!
  const enabledModels = new Map<string, string>()
  for (const channel of channels) for (const model of channel.models) if (model.enabled) enabledModels.set(model.id, model.name)
  const modelsById = new Map<string, OfficialChannelHealth['models']>()
  for (const channel of channels) {
    const channelHealth = health.find((item) => item.channelId === channel.id)
    for (const model of channelHealth?.models ?? []) {
      const current = modelsById.get(model.modelId) ?? []
      current.push(model)
      modelsById.set(model.modelId, current)
    }
  }
  const groupedHealth = new Map([...modelsById].map(([modelId, models]) => [modelId, aggregateModelHealth(models)]))
  const supportsClaude = channels.some((channel) => isChannelEnabledForRuntime(channel, 'claude'))
  const multiple = channels.length > 1
  return (
    <div className="group border-b border-border/50 last:border-b-0">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30" aria-expanded={expanded}>
        <img src={getChannelLogo(representative)} alt="" className="h-8 w-8 shrink-0 rounded" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{isModelFamily ? getOfficialChannelDisplayName(representative) : `${representative.name} · 官方`}{multiple ? ` · ${channels.length} 个渠道` : ''}</span>
          <span className="block truncate text-xs text-muted-foreground">{isModelFamily ? `${PROVIDER_LABELS[representative.provider]} 协议 · 当前账号 ${enabledModels.size} 个模型可用` : `${PROVIDER_LABELS[representative.provider]} · ${enabledModels.size} 个模型已启用`}</span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {supportsClaude && <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-600">Claude</span>}
          {channels.some((channel) => isChannelEnabledForRuntime(channel, 'pi')) && <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-success/10 text-success">Pi</span>}
          <ChevronDown size={16} className={`ml-1 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {expanded && <div className="border-t border-border/50 bg-muted/20 px-5 py-3 pl-[68px] space-y-2">
        {isModelFamily ? <p className="text-xs text-muted-foreground">这是服务端汇流的模型池；普通/VIP 路由、上游主备与故障重试由后台自动处理。</p> : multiple ? <p className="text-xs text-muted-foreground">已合并 {channels.length} 个同名官方渠道；上游主备与重试由 New API 自动处理。</p> : null}
        {channels.map((channel) => (
          <div key={channel.id} className="space-y-3 py-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 break-words font-medium">{channel.name}</span>
              <Switch disabled={busy} checked={channel.enabled} onCheckedChange={() => { void runUpdate(() => onToggleChannel(channel)) }} aria-label={`启用 ${channel.name} 渠道`} />
            </div>
            {channel.models.length === 0 && <p className="text-xs text-muted-foreground">当前渠道暂无模型</p>}
            {channel.models.map((model) => {
              const summary = groupedHealth.get(model.id)
              return <div key={model.id} className="space-y-1">
                <div className="flex items-center gap-3 text-xs">
                  <span className="min-w-0 flex-1 break-words text-foreground">{model.name}</span>
                  <Switch disabled={busy} checked={model.enabled} onCheckedChange={() => { void runUpdate(() => onToggleModel(channel, model.id)) }} aria-label={`启用 ${channel.name} 的 ${model.name}`} />
                </div>
                {summary && <ModelAvailabilityBar model={summary.model} samples={summary.slots} compact />}
              </div>
            })}
          </div>
        ))}
      </div>}
    </div>
  )
}

// ===== 渠道行子组件 =====

interface ChannelRowProps {
  channel: Channel
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
  commercialMode?: boolean
  canSelfConfig?: boolean
  health?: OfficialChannelHealth
  busy?: boolean
}

function ChannelRow({ channel, onEdit, onDelete, onToggle, commercialMode, canSelfConfig, busy, health }: ChannelRowProps): React.ReactElement {
  const isOfficial = isOfficialChannel(channel)
  const [expanded, setExpanded] = React.useState(false)
  const enabledCount = channel.models.filter((m) => m.enabled).length
  const canExpand = isOfficial && !!health?.models.length
  const toggleExpanded = () => {
    if (canExpand) setExpanded((value) => !value)
  }
  const description = [
    PROVIDER_LABELS[channel.provider],
    enabledCount > 0 ? `${enabledCount} 个模型已启用` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  const controls = (
    <div className="flex items-center gap-2.5" onClick={(event) => event.stopPropagation()}>
      {/* Agent Core 兼容性标签 */}
      <AgentCoreChips channel={channel} />

      {/* 操作按钮 */}
        {!isOfficial && canSelfConfig && (
          <>
            <button
              onClick={onEdit}
              disabled={busy}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100"
              title="编辑"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={onDelete}
              disabled={busy}
              className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}

        {/* 启用/关闭开关 */}
      <Switch
        disabled={busy}
        aria-label={`启用 ${channel.name} 渠道`}
        checked={channel.enabled}
        onCheckedChange={onToggle}
      />
      {canExpand && (
        <button
          type="button"
          onClick={toggleExpanded}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={expanded ? `收起 ${channel.name} 模型可用性` : `展开 ${channel.name} 模型可用性`}
          aria-expanded={expanded}
        >
          <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </div>
  )

  if (!canExpand) {
    return (
      <SettingsRow
        label={channel.name + (isOfficial ? ' · 官方' : '')}
        icon={<img src={getChannelLogo(channel)} alt="" className="w-8 h-8 rounded" />}
        description={description}
        className="group"
      >
        {controls}
      </SettingsRow>
    )
  }

  return (
    <div className="group border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
        aria-expanded={expanded}
      >
        <img src={getChannelLogo(channel)} alt="" className="h-8 w-8 shrink-0 rounded" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{channel.name} · 官方</span>
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        </span>
        {controls}
      </button>
      {expanded && health && (
        <div className="border-t border-border/50 bg-muted/20 px-5 py-2 pl-[68px]">
          {health.models.map((model) => <ModelAvailabilityBar key={model.modelId} model={model} />)}
        </div>
      )}
    </div>
  )
}

// ===== Agent Core 兼容性标签 =====

function AgentCoreChips({ channel }: { channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'> }): React.ReactElement {
  const supportsClaude = isChannelEnabledForRuntime(channel, 'claude')
  const piCoreState = resolvePiCoreState(channel)
  const isExperimentalXai = piCoreState !== 'active'

  return (
    <span className="flex items-center gap-1 shrink-0">
      {supportsClaude && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
          Claude
        </span>
      )}
      {isChannelEnabledForRuntime(channel, 'pi') && <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${isExperimentalXai ? 'bg-warning/10 text-warning border border-warning/20' : 'bg-success/10 text-success border border-success/20'}`}>
        {isExperimentalXai ? (piCoreState === 'experimental-active' ? 'Pi 实验' : 'Pi 实验未启用') : 'Pi'}
      </span>}
    </span>
  )
}
