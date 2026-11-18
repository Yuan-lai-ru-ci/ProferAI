import type { AgentRuntime, Channel } from '@profer/shared'
import { isChannelEnabledForRuntime } from '@profer/shared'
import { getChannelProtocol } from './channel-model-groups'

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

/** 历史会话仅校验，不自动替换其绑定模型。 */
export function isAgentModelSelectionValid(
  channels: Channel[], runtime: AgentRuntime, claudeChannelIds: string[], selection: AgentModelSelection,
): boolean {
  const channel = channels.find((item) => item.id === selection.channelId)
  if (!channel?.enabled) return false
  if (runtime === 'claude' && channel.agentRuntimes === undefined && !claudeChannelIds.includes(channel.id)) return false
  return isChannelEnabledForRuntime(channel, runtime)
    && channel.models.some((model) => model.id === selection.modelId && model.enabled)
}

export type AgentBindingState =
  | 'ok'
  | 'unbound'
  | 'channel_missing'
  | 'channel_disabled'
  | 'model_unavailable'

/**
 * 区分「未绑定」「渠道已删除/停用」「渠道还在但模型不可用」。
 *
 * 三者都会让输入区不可用，但只有渠道存在的情况才该引导用户去设置页；
 * 渠道引用悬空时去设置页看到的是一份完全正常的配置，必须改成「重新选择模型」。
 */
export function resolveAgentBindingState(
  channels: Channel[],
  runtime: AgentRuntime,
  claudeChannelIds: string[],
  bound: { channelId?: string | null; modelId?: string | null } | null | undefined,
): AgentBindingState {
  if (!bound?.channelId) return 'unbound'
  const channel = channels.find((item) => item.id === bound.channelId)
  if (!channel) return 'channel_missing'
  if (!channel.enabled) return 'channel_disabled'
  if (!bound.modelId) return 'model_unavailable'
  return isAgentModelSelectionValid(channels, runtime, claudeChannelIds, {
    channelId: bound.channelId,
    modelId: bound.modelId,
  })
    ? 'ok'
    : 'model_unavailable'
}

/** Resolve a model that is valid for the selected Agent runtime. */
export function resolveAgentModelSelection(
  channels: Channel[],
  runtime: AgentRuntime,
  claudeChannelIds: string[],
  current?: AgentModelSelection | null,
): AgentModelSelection | null {
  /**
   * 可用性判定改为按渠道上用户勾选的 Agent 内核（`agentRuntimes`），不再按渠道类型。
   * 未迁移的老配置（agentRuntimes === undefined）仍用历史 Claude 白名单兜底，
   * 保证升级瞬间的行为不变。
   */
  const isEligibleChannel = (channel: Channel): boolean => {
    if (!channel.enabled) return false
    if (runtime !== 'pi' && channel.agentRuntimes === undefined && !claudeChannelIds.includes(channel.id)) return false
    return isChannelEnabledForRuntime(channel, runtime === 'pi' ? 'pi' : 'claude')
  }

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
        ...eligibleChannels.filter((channel) => getChannelProtocol(channel.provider) === 'openai'),
        ...eligibleChannels.filter((channel) => getChannelProtocol(channel.provider) !== 'openai'),
      ]
    : eligibleChannels
  for (const channel of orderedChannels) {
    const model = channel.models.find((item) => item.enabled)
    if (model) return { channelId: channel.id, modelId: model.id }
  }

  return null
}

export interface AgentRuntimeSelection extends AgentModelSelection {
  runtime: AgentRuntime
}

/**
 * 内核跟着可用渠道走：当前内核没有任何可用渠道时，回退到另一个内核。
 *
 * 典型场景是新装默认 `agentRuntime = claude`，而用户只配了只勾 Pi 内核的渠道
 * （DeepSeek 等非 Anthropic 白名单 provider 只会推导出 `['pi']`）。
 * 以前这里会解析成「没有 Agent 渠道」，把已经配好的渠道判成没配；
 * 配一个渠道就该能用，内核由渠道能力决定。
 *
 * 只有两个内核都没有可用渠道时才返回 null。
 */
export function resolveAgentRuntimeSelection(
  channels: Channel[],
  preferredRuntime: AgentRuntime,
  claudeChannelIds: string[],
  current?: AgentModelSelection | null,
): AgentRuntimeSelection | null {
  const preferred = resolveAgentModelSelection(channels, preferredRuntime, claudeChannelIds, current)
  if (preferred) return { runtime: preferredRuntime, ...preferred }

  const fallbackRuntime: AgentRuntime = preferredRuntime === 'pi' ? 'claude' : 'pi'
  const fallback = resolveAgentModelSelection(channels, fallbackRuntime, claudeChannelIds, current)
  return fallback ? { runtime: fallbackRuntime, ...fallback } : null
}
