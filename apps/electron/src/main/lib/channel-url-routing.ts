import type { Channel, ChannelsConfig, ProviderType } from '@profer/shared'
import { PROVIDER_DEFAULT_AGENT_URLS, PROVIDER_DEFAULT_URLS, isAgentCompatibleProvider } from '@profer/shared'
import { normalizeBaseUrl } from '@profer/core'

function hasAnthropicPath(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).pathname.toLowerCase().includes('/anthropic')
  } catch {
    return baseUrl.toLowerCase().includes('/anthropic')
  }
}

function isOfficialDeepSeekV1Url(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    return url.hostname === 'api.deepseek.com' && url.pathname.replace(/\/+$/, '') === '/v1'
  } catch {
    return baseUrl.trim().replace(/\/+$/, '') === 'https://api.deepseek.com/v1'
  }
}

export function inferAgentBaseUrl(provider: ProviderType, baseUrl?: string, agentBaseUrl?: string): string | undefined {
  const explicit = agentBaseUrl?.trim()
  if (explicit) return explicit

  if (provider === 'deepseek') {
    if (hasAnthropicPath(baseUrl)) return normalizeBaseUrl(baseUrl ?? '')
    return PROVIDER_DEFAULT_AGENT_URLS.deepseek
  }

  if (provider === 'anthropic-compatible') {
    return baseUrl?.trim() ? normalizeBaseUrl(baseUrl) : undefined
  }

  // Pi runtime 原生支持 OpenAI Completions / Responses；它们没有独立的
  // Anthropic Agent endpoint，必须复用用户渠道的 Base URL。否则已有 OpenAI
  // 渠道在切换到 Pi 时会把 undefined 传入模型注册层。
  const usesPiOpenAiApi = provider === 'openai' || provider === 'openai-responses'
  return PROVIDER_DEFAULT_AGENT_URLS[provider]
    ?? (isAgentCompatibleProvider(provider) || usesPiOpenAiApi ? baseUrl?.trim() : undefined)
}

export function normalizeChannelForCurrentSchema(channel: Channel): { channel: Channel; changed: boolean } {
  let changed = false
  let next: Channel = { ...channel }

  if (next.provider === 'deepseek') {
    if (hasAnthropicPath(next.baseUrl)) {
      next = {
        ...next,
        agentBaseUrl: next.agentBaseUrl?.trim() || normalizeBaseUrl(next.baseUrl),
        baseUrl: PROVIDER_DEFAULT_URLS.deepseek,
      }
      changed = true
    } else if (isOfficialDeepSeekV1Url(next.baseUrl)) {
      next = { ...next, baseUrl: PROVIDER_DEFAULT_URLS.deepseek }
      changed = true
    } else if (!next.baseUrl?.trim()) {
      next = { ...next, baseUrl: PROVIDER_DEFAULT_URLS.deepseek }
      changed = true
    }
  }

  const inferredAgentBaseUrl = inferAgentBaseUrl(next.provider, next.baseUrl, next.agentBaseUrl)
  if (inferredAgentBaseUrl && next.agentBaseUrl !== inferredAgentBaseUrl) {
    next = { ...next, agentBaseUrl: inferredAgentBaseUrl }
    changed = true
  }

  return { channel: next, changed }
}

export function normalizeConfigForCurrentSchema(config: ChannelsConfig): { config: ChannelsConfig; changed: boolean } {
  let changed = false
  const channels = config.channels.map((channel) => {
    const result = normalizeChannelForCurrentSchema(channel)
    if (result.changed) changed = true
    return result.channel
  })
  return { config: { ...config, channels }, changed }
}

