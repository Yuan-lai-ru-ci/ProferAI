import type { Channel, ChannelsConfig, ProviderType } from '@profer/shared'
import { PROVIDER_CAPABILITIES, PROVIDER_DEFAULT_AGENT_URLS, PROVIDER_DEFAULT_URLS, inferAgentRuntimeModes, isAgentCompatibleProvider } from '@profer/shared'
import { isAnthropicShapedEndpoint, normalizeBaseUrl } from '@profer/core'

/** 是否指向 DeepSeek 官方域名；第三方网关不得被官方默认值迁移逻辑覆盖。 */
function isOfficialDeepSeekHost(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
  } catch {
    return baseUrl.trim().toLowerCase().includes('api.deepseek.com')
  }
}

/**
 * 官方 DeepSeek Anthropic Agent 入口（含历史迁移遗留的写法）。
 *
 * 该地址只是官方推导结果，并非用户意图；用户把 Chat Base URL 切到第三方
 * 网关后，不能再让它继续把 Agent 请求送回官方端点。
 */
function isOfficialDeepSeekAgentUrl(baseUrl?: string): boolean {
  const raw = baseUrl?.trim()
  if (!raw || !isOfficialDeepSeekHost(raw)) return false
  let path: string
  try {
    path = new URL(raw).pathname
  } catch {
    path = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/, '')
  }
  const normalized = path.replace(/\/+$/, '').toLowerCase()
  return normalized === '/anthropic' || normalized === '/anthropic/v1' || normalized === '/anthropic/v1/messages'
}

// Pi 原生 API 渠道（Pi 直接消费 baseUrl 而不是 agentBaseUrl）从能力描述符派生：
// 即「原生协议不是 anthropic-messages」的 provider。原先手工枚举的 openai /
// openai-responses / opencode-go-openai / zhipu / doubao / qwen / google / custom / xai
// 正好是「非 anthropic 协议」集合，与派生结果等价，不再单独维护。
const PI_NATIVE_BASE_URL_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>(
  (Object.keys(PROVIDER_CAPABILITIES) as ProviderType[]).filter(
    (provider) => !PROVIDER_CAPABILITIES[provider].isAnthropicProtocol
      // openai-codex 虽非 anthropic 协议，但走 OAuth 内置目录、baseUrl 为空，
      // 不属于「Pi 复用用户配置 baseUrl」的场景，与原手工集合保持一致排除。
      && provider !== 'openai-codex',
  ),
)

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

  if (provider === 'deepseek') {
    // 显式配置的非官方 Agent 入口优先：同时提供双协议的网关可以单独指定。
    if (explicit && !isOfficialDeepSeekAgentUrl(explicit)) return explicit
    // 官方 Agent 默认值不再优先于当前 Chat Base URL。历史配置把官方默认值
    // 持久化进 agentBaseUrl，用户切换 Base URL 后 Agent 会继续打旧地址，
    // 这是「换了 URL 仍请求不到」的根因。Agent 必须跟随当前 Base URL 推导。
    if (isAnthropicShapedEndpoint(baseUrl)) return normalizeBaseUrl(baseUrl ?? '')
    if (!baseUrl?.trim() || isOfficialDeepSeekHost(baseUrl)) return PROVIDER_DEFAULT_AGENT_URLS.deepseek
    return normalizeBaseUrl(baseUrl)
  }

  if (explicit) return explicit

  if (provider === 'ollama') {
    const normalized = normalizeBaseUrl(baseUrl ?? '')
    return normalized ? normalized.replace(/\/v1$/, '') : undefined
  }

  if (provider === 'anthropic-compatible') {
    return baseUrl?.trim() ? normalizeBaseUrl(baseUrl) : undefined
  }

  // Pi 原生 API 渠道没有独立的 Anthropic Agent endpoint，必须复用用户配置的
  // Base URL；否则会把 undefined 传入模型注册层。
  return PROVIDER_DEFAULT_AGENT_URLS[provider]
    ?? (isAgentCompatibleProvider(provider) || PI_NATIVE_BASE_URL_PROVIDERS.has(provider)
      ? baseUrl?.trim()
      : undefined)
}

export function normalizeChannelForCurrentSchema(channel: Channel): { channel: Channel; changed: boolean } {
  let changed = false
  let next: Channel = { ...channel }

  if (next.provider === 'xai' && !next.baseUrl?.trim()) {
    next = { ...next, baseUrl: PROVIDER_DEFAULT_URLS.xai }
    changed = true
  }

  if (next.provider === 'deepseek') {
    // 只迁移官方 DeepSeek 的 Anthropic 地址；用户自定义网关可能也包含
    // /anthropic，不能再被硬编码覆盖回 api.deepseek.com。
    if (isOfficialDeepSeekAgentUrl(next.baseUrl)) {
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

  // 静默迁移：老配置没有勾选字段，按现有 provider 规则推导一次并写回。
  // 推导结果与迁移前的门禁行为等价，用户不会感知到能力变化。
  if (!next.agentRuntimes) {
    next = { ...next, agentRuntimes: inferAgentRuntimeModes(next) }
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

