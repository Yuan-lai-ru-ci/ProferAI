import {
  isChannelEnabledForChat,
  isChannelEnabledForRuntime,
} from '@profer/shared'
import type { AgentRuntimeMode, Channel } from '@profer/shared'

export interface QuickTaskSettings {
  agentChannelId?: string
  agentModelId?: string
  agentRuntime?: AgentRuntimeMode
}

export interface QuickTaskSelectedModel {
  channelId: string
  modelId: string
}

export interface QuickTaskModelInfo {
  channelName: string
  modelId: string
}

/** 快速任务只展示当前模式下仍可实际发送的启用模型。 */
export function resolveQuickTaskModelInfo(
  mode: 'chat' | 'agent',
  settings: QuickTaskSettings,
  channels: Channel[],
  selectedModel?: QuickTaskSelectedModel,
): QuickTaskModelInfo | null {
  const selection = mode === 'agent'
    ? settings.agentChannelId && settings.agentModelId
      ? { channelId: settings.agentChannelId, modelId: settings.agentModelId }
      : null
    : selectedModel ?? null
  if (!selection) return null

  const channel = channels.find((candidate) => candidate.id === selection.channelId)
  if (!channel) return null
  const channelEnabled = mode === 'agent'
    ? isChannelEnabledForRuntime(channel, settings.agentRuntime ?? 'claude')
    : isChannelEnabledForChat(channel)
  if (!channelEnabled) return null
  if (!channel.models.some((model) => model.id === selection.modelId && model.enabled)) return null
  return { channelName: channel.name, modelId: selection.modelId }
}
