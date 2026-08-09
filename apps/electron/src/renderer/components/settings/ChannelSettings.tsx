/**
 * ChannelSettings - 渠道配置页
 *
 * 管理所有渠道的添加、编辑、删除与启用状态；每个渠道直接展示可用的 Agent Core。
 * Chat 与 Agent 视觉上统一为一个列表，Agent 兼容性通过内联标签展示。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Plus, Pencil, Trash2, Server, RefreshCw, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PROVIDER_LABELS, isAgentCompatibleProvider } from '@profer/shared'
import type { Channel, OfficialChannelHealth, ProviderType } from '@profer/shared'
import { getChannelLogo } from '@/lib/model-logo'
import { agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
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
} from '@/components/ui/alert-dialog'
import { ChannelForm } from './ChannelForm'
import { ModelAvailabilityBar } from './ModelAvailabilityBar'
import { isOfficialChannel } from '@/lib/channel-model-groups'
import { aggregateModelHealth } from '@/lib/channel-health-aggregation'

/** 组件视图模式 */
type ViewMode = 'list' | 'create' | 'edit'

export function ChannelSettings(): React.ReactElement {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [officialHealth, setOfficialHealth] = React.useState<OfficialChannelHealth[]>([])
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [editingChannel, setEditingChannel] = React.useState<Channel | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [commercialMode, setCommercialMode] = React.useState(false)
  const [canSelfConfig, setCanSelfConfig] = React.useState(false)
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom)
  const [, setAgentModelId] = useAtom(agentModelIdAtom)
  const [agentChannelIds, setAgentChannelIds] = useAtom(agentChannelIdsAtom)
  const setGlobalChannels = useSetAtom(channelsAtom)
  const authStatus = useAtomValue(authStatusAtom)
  const [deleteTarget, setDeleteTarget] = React.useState<Channel | null>(null)
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
    try {
      const caps = await window.electronAPI.getAccountCapabilities(force)
      setCommercialMode(caps.commercialMode)
      setCanSelfConfig(caps.canSelfConfig)
      return caps
    } catch {
      setCommercialMode(false)
      setCanSelfConfig(false)
      return null
    }
  }, [])

  React.useEffect(() => {
    loadCaps(false).then((caps) => {
      if (caps && caps.commercialMode && !caps.canSelfConfig) loadCaps(true)
    })
  }, [loadCaps])

  const handleRefreshCaps = React.useCallback(async () => {
    setRefreshingCaps(true)
    try {
      await loadCaps(true)
    } finally {
      setRefreshingCaps(false)
    }
  }, [loadCaps])

  /** 加载渠道列表（未登录时隐藏服务端托管的官方渠道，避免残留缓存展示给未登录用户） */
  const loadChannels = React.useCallback(async (): Promise<Channel[]> => {
    try {
      const list = await window.electronAPI.listChannels()
      const visible = authStatus.isLoggedIn ? list : list.filter((c) => !c.id.startsWith('newapi-'))
      setChannels(visible)
      setGlobalChannels(visible)
      return visible
    } catch (error) {
      console.error('[渠道设置] 加载渠道列表失败:', error)
      return []
    } finally {
      setLoading(false)
    }
  }, [authStatus.isLoggedIn])

  React.useEffect(() => {
    loadChannels()
    if (authStatus.isLoggedIn) {
      window.electronAPI.getOfficialModelHealth().then(setOfficialHealth).catch(() => setOfficialHealth([]))
    } else {
      setOfficialHealth([])
    }
  }, [loadChannels, authStatus.isLoggedIn])

  // 渠道启用/兼容性变化 → 自动同步 Agent 渠道列表
  // 当渠道启用且 provider 兼容 Agent 时，自动纳入 agentChannelIds；
  // 当渠道关闭或不兼容时，自动从 agentChannelIds 移除。
  React.useEffect(() => {
    if (loading) return
    const derivedIds = channels
      .filter((c) => c.enabled && isAgentCompatibleProvider(c.provider))
      .map((c) => c.id)
    const currentIds = agentChannelIdsRef.current
    const unchanged =
      derivedIds.length === currentIds.length &&
      derivedIds.every((id, index) => id === currentIds[index])
    if (unchanged) return
    agentChannelIdsRef.current = derivedIds
    setAgentChannelIds(derivedIds)
    window.electronAPI.updateSettings({ agentChannelIds: derivedIds }).catch(console.error)
  }, [channels, loading, setAgentChannelIds])

  // 商业模式且无自配权限时：不允许进入创建/编辑视图
  React.useEffect(() => {
    const locked = commercialMode && !canSelfConfig
    if (!locked || viewMode === 'list') return
    setViewMode('list')
    setEditingChannel(null)
  }, [commercialMode, canSelfConfig, viewMode])

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
    if (agentChannelIdRef.current === channel.id) {
      agentChannelIdRef.current = null
      setAgentChannelId(null)
      setAgentModelId(null)
      updates.agentChannelId = undefined
      updates.agentModelId = undefined
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
    try {
      await window.electronAPI.deleteChannel(target.id)

      const newIds = agentChannelIds.filter((id) => id !== target.id)
      setAgentChannelIds(newIds)

      if (agentChannelId === target.id) {
        setAgentChannelId(null)
        setAgentModelId(null)
      }

      await window.electronAPI.updateSettings({
        agentChannelIds: newIds,
        ...(agentChannelId === target.id && { agentChannelId: undefined, agentModelId: undefined }),
      })

      await loadChannels()
      setDeleteTarget(null)
    } catch (error) {
      console.error('[渠道设置] 删除渠道失败:', error)
    }
  }

  /** 切换渠道启用状态 — 同时自动同步 Agent 兼容性 */
  const handleToggle = async (channel: Channel): Promise<void> => {
    try {
      const savedChannel = await window.electronAPI.updateChannel(channel.id, { enabled: !channel.enabled })
      await syncAgentChannelEligibility(
        savedChannel,
        savedChannel.enabled && isAgentCompatibleProvider(savedChannel.provider),
      )
      await loadChannels()
    } catch (error) {
      console.error('[渠道设置] 切换渠道状态失败:', error)
    }
  }

  /** 表单保存回调 */
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
  if ((viewMode === 'create' || viewMode === 'edit') && !(commercialMode && !canSelfConfig)) {
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
      {/* 模型配置（Chat 与 Agent 统一） */}
      <SettingsSection
        title="模型配置"
        description={
          commercialMode && !canSelfConfig
            ? '渠道由团队服务器统一管理，无需手动配置'
            : '管理 AI 供应商连接，配置 API Key 和可用模型。支持 Agent 的渠道会显示对应标签'
        }
        action={
          (commercialMode && !canSelfConfig) ? null : (
            <Button size="sm" onClick={() => setViewMode('create')}>
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
                <div className="text-sm font-medium">渠道由服务端统一管理</div>
                <div className="text-xs text-muted-foreground">管理员在后台配置渠道后自动同步到你的客户端。你当前没有自配 API 权限（可能被管理员单独关闭），如需自行添加 API Key，请联系管理员开通后点「刷新权限」</div>
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
                  {groupOfficialChannels(officialChannels).map((group) => <OfficialChannelGroupRow key={`${group.name}:${group.provider}`} channels={group.channels} health={officialHealth} />)}
                  {selfConfiguredChannels.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      commercialMode={commercialMode}
                      canSelfConfig={canSelfConfig}
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
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定删除渠道？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除渠道「{deleteTarget?.name}」？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface OfficialChannelGroup { name: string; provider: ProviderType; channels: Channel[] }

function groupOfficialChannels(channels: Channel[]): OfficialChannelGroup[] {
  const groups = new Map<string, OfficialChannelGroup>()
  for (const channel of channels) {
    const name = channel.name.trim()
    const key = `${channel.provider}:${name}`
    const existing = groups.get(key)
    if (existing) existing.channels.push(channel)
    else groups.set(key, { name, provider: channel.provider, channels: [channel] })
  }
  return [...groups.values()]
}

function OfficialChannelGroupRow({ channels, health }: { channels: Channel[]; health: OfficialChannelHealth[] }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
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
  const supportsClaude = isAgentCompatibleProvider(representative.provider)
  const multiple = channels.length > 1
  return (
    <div className="group border-b border-border/50 last:border-b-0">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30" aria-expanded={expanded}>
        <img src={getChannelLogo(representative)} alt="" className="h-8 w-8 shrink-0 rounded" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{representative.name} · 官方{multiple ? ` · ${channels.length} 个渠道` : ''}</span>
          <span className="block truncate text-xs text-muted-foreground">{PROVIDER_LABELS[representative.provider]} · {enabledModels.size} 个模型已启用</span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {supportsClaude && <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-600">Claude</span>}
          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-600">Pi</span>
          <ChevronDown size={16} className={`ml-1 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {expanded && <div className="border-t border-border/50 bg-muted/20 px-5 py-3 pl-[68px] space-y-2">
        {multiple && <p className="text-xs text-muted-foreground">已合并 {channels.length} 个同名官方渠道；上游主备与重试由 New API 自动处理。</p>}
        {[...enabledModels.entries()].map(([id, name]) => {
          const summary = groupedHealth.get(id)
          return <div key={id} className="space-y-1"><div className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate text-foreground">{name}</span></div>{summary && <ModelAvailabilityBar model={summary.model} samples={summary.slots} compact />}</div>
        })}
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
}

function ChannelRow({ channel, onEdit, onDelete, onToggle, commercialMode, canSelfConfig, health }: ChannelRowProps): React.ReactElement {
  const isOfficial = channel.id.startsWith('newapi-')
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
      <AgentCoreChips provider={channel.provider} />

      {/* 操作按钮 */}
        {!isOfficial && (!commercialMode || canSelfConfig) && (
          <>
            <button
              onClick={onEdit}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100"
              title="编辑"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}

        {/* 启用/关闭开关 */}
      <Switch
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

function AgentCoreChips({ provider }: { provider: string }): React.ReactElement {
  const supportsClaude = isAgentCompatibleProvider(provider as ProviderType)

  return (
    <span className="flex items-center gap-1 shrink-0">
      {supportsClaude && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
          Claude
        </span>
      )}
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        Pi
      </span>
    </span>
  )
}
