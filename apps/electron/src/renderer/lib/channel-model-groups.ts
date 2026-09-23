import type { Channel, ChannelModel } from '@profer/shared'
import { isChannelEnabledForRuntime } from '@profer/shared'

export type ChannelSource = 'official' | 'self-configured'
export type ChannelProtocol = 'openai' | 'anthropic'

/** 判定 Agent 内核可用性所需的渠道字段。 */
export type ChannelRuntimeCapability = Pick<
  Channel,
  'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'
>

export interface ChannelModelGroup {
  modelId: string
  modelName: string
  source: ChannelSource
  channelIds: string[]
  channelNames: string[]
  enabledChannelIds: string[]
  enabled: boolean
  protocols: ChannelProtocol[]
}

export function isOfficialChannel(channel: Pick<Channel, 'id' | 'serverManaged'>): boolean {
  return channel.serverManaged === true || channel.id.startsWith('newapi-')
}

export function isModelFamilyChannel(channel: Pick<Channel, 'id' | 'managedType'>): boolean {
  return channel.managedType === 'model-family' || channel.id.startsWith('newapi-family-')
}

export function getOfficialChannelDisplayName(channel: Pick<Channel, 'id' | 'name' | 'managedType'>): string {
  return isModelFamilyChannel(channel) ? `${channel.name} 模型池` : channel.name
}

export function getChannelSource(channel: Pick<Channel, 'id' | 'serverManaged'>): ChannelSource {
  return isOfficialChannel(channel) ? 'official' : 'self-configured'
}

export function getChannelProtocol(provider: Channel['provider']): ChannelProtocol {
  const anthropicProviders = new Set([
    'anthropic', 'anthropic-compatible', 'kimi-api', 'kimi-coding',
    'zhipu-coding', 'zhipu-coding-team', 'minimax', 'xiaomi',
    'xiaomi-token-plan', 'qwen-anthropic',
  ])
  return anthropicProviders.has(provider) ? 'anthropic' : 'openai'
}

/**
 * 渠道列表「Pi」内核标签的状态。
 *
 * 必须按用户真正勾选的 Pi 内核判定，不能沿用 `isAgentEnabledForChannel`：
 * 后者是「是否勾选 Claude 内核」的 @deprecated 别名，而 xAI 按设计永远不获得 claude 内核，
 * 于是已开启实验性 Agent 的 xAI 渠道会被显示成「Pi 实验未启用」，与事实相反。
 */
export type PiCoreState = 'active' | 'experimental-active' | 'experimental-inactive'

export function resolvePiCoreState(
  channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'>,
): PiCoreState {
  if (channel.provider !== 'xai') return 'active'
  return isChannelEnabledForRuntime(channel, 'pi') ? 'experimental-active' : 'experimental-inactive'
}

/**
 * 该渠道能否服务于指定协议的 Agent 运行时。
 *
 * Agent 场景下「协议」等价于「内核」：Anthropic 协议 = Claude 内核，OpenAI 协议 = Pi 内核。
 * 判定依据是渠道上用户勾选的 `agentRuntimes`（老配置回退到 provider 推导），
 * **不再按渠道类型加门禁**——能不能用由用户勾选与填写的地址一并决定。
 *
 * getChannelProtocol 仍保留单一展示值，供分组与标签使用。
 */
export function supportsChannelProtocol(
  channel: ChannelRuntimeCapability,
  protocol: ChannelProtocol,
): boolean {
  return isChannelEnabledForRuntime(channel, protocol === 'anthropic' ? 'claude' : 'pi')
}

export function groupChannelModels(channels: Channel[]): ChannelModelGroup[] {
  const groups = new Map<string, ChannelModelGroup>()
  for (const channel of channels) {
    if (!channel.enabled) continue
    const source = getChannelSource(channel)
    for (const model of channel.models) {
      if (!model.enabled) continue
      const key = `${source}:${model.id}`
      const existing = groups.get(key)
      const protocol = getChannelProtocol(channel.provider)
      if (existing) {
        if (!existing.channelIds.includes(channel.id)) existing.channelIds.push(channel.id)
        if (!existing.channelNames.includes(channel.name)) existing.channelNames.push(channel.name)
        existing.enabledChannelIds.push(channel.id)
        if (!existing.protocols.includes(protocol)) existing.protocols.push(protocol)
        continue
      }
      groups.set(key, {
        modelId: model.id,
        modelName: model.name,
        source,
        channelIds: [channel.id],
        channelNames: [channel.name],
        enabledChannelIds: [channel.id],
        enabled: true,
        protocols: [protocol],
      })
    }
  }
  return [...groups.values()].sort((a, b) => a.modelName.localeCompare(b.modelName))
}

export function getModelSourceLabel(source: ChannelSource): string {
  return source === 'official' ? '官方托管' : '自配渠道'
}

export function getEnabledModelCount(channel: Pick<Channel, 'models'>): number {
  return channel.models.filter((model: ChannelModel) => model.enabled).length
}
