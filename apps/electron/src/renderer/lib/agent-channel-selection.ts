import type { AgentRuntime, Channel } from '@profer/shared'
import { getChannelProtocol, supportsChannelProtocol } from './channel-model-groups'

/** Pi can use every enabled channel without changing Claude's compatibility whitelist. */
export function nextAgentChannelIdsAfterModelSelect(
  currentChannelIds: string[],
  selectedChannelId: string,
  runtime: AgentRuntime,
): string[] {
  if (runtime !== 'claude') return currentChannelIds
  return currentChannelIds.includes(selectedChannelId)
    ? currentChannelIds
    : [...currentChannelIds, selectedChannelId]
}

export interface AgentModelSelection {
  channelId: string
  modelId: string
}

/** Resolve a model that is valid for the selected Agent runtime. */
export function resolveAgentModelSelection(
  channels: Channel[],
  runtime: AgentRuntime,
  claudeChannelIds: string[],
  current?: AgentModelSelection | null,
): AgentModelSelection | null {
  const preferredProtocol = runtime === 'pi' ? 'openai' : 'anthropic'
  const isEligibleChannel = (channel: Channel): boolean => (
    channel.enabled
      // Pi supports both OpenAI and Anthropic protocols. Its backend registry
      // selects the wire protocol per provider, so do not hide Anthropic
      // channels merely because OpenAI is the preferred fallback order.
      && (runtime === 'pi' || supportsChannelProtocol(channel.provider, preferredProtocol))
      && (runtime === 'pi' || claudeChannelIds.includes(channel.id))
  )

  if (current) {
    const channel = channels.find((item) => item.id === current.channelId)
    if (channel && isEligibleChannel(channel) && channel.models.some((model) => model.enabled && model.id === current.modelId)) {
      return current
    }
  }

  // Preserve the existing OpenAI-first fallback for Pi, while allowing Claude
  // as the fallback when no OpenAI-compatible channel has an enabled model.
  const eligibleChannels = channels.filter(isEligibleChannel)
  const orderedChannels = runtime === 'pi'
    ? [
        ...eligibleChannels.filter((channel) => supportsChannelProtocol(channel.provider, 'openai')),
        ...eligibleChannels.filter((channel) => !supportsChannelProtocol(channel.provider, 'openai')),
      ]
    : eligibleChannels
  for (const channel of orderedChannels) {
    const model = channel.models.find((item) => item.enabled)
    if (model) return { channelId: channel.id, modelId: model.id }
  }

  return null
}
