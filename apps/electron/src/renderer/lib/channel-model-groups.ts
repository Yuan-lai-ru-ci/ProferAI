import type { Channel, ChannelModel } from '@profer/shared'

export type ChannelSource = 'official' | 'self-configured'
export type ChannelProtocol = 'openai' | 'anthropic'

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
 * Some channels expose more than one wire protocol. Ollama uses OpenAI
 * compatibility for Chat and Anthropic compatibility for Claude/Pi Agent.
 * Keep getChannelProtocol's single display value for existing grouping code,
 * but use this predicate whenever a runtime applies a strict protocol filter.
 */
export function supportsChannelProtocol(
  provider: Channel['provider'],
  protocol: ChannelProtocol,
): boolean {
  return provider === 'ollama' || getChannelProtocol(provider) === protocol
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
