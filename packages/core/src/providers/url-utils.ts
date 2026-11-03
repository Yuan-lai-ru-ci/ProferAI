/**
 * URL 规范化工具
 *
 * 各供应商 Base URL 的规范化处理。
 * 所有 Anthropic URL 规范化逻辑统一收口在此文件，避免分散重复。
 */

import type { ProviderType } from '@profer/shared'
import { PROVIDER_CAPABILITIES, PROVIDER_DEFAULT_AGENT_URLS, PROVIDER_DEFAULT_URLS, isAgentCompatibleProvider } from '@profer/shared'

/** 只变换 pathname，查询路由与 fragment 始终留在端点末尾。 */
function mapUrlPath(rawUrl: string, transform: (path: string) => string): string {
  const trimmed = rawUrl.trim()
  const separatorIndex = trimmed.search(/[?#]/)
  const head = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex)
  const tail = separatorIndex === -1 ? '' : trimmed.slice(separatorIndex)
  try {
    const parsed = new URL(head)
    parsed.pathname = transform(parsed.pathname.replace(/\/+$/, '')) || '/'
    return `${parsed.toString().replace(/\/+$/, '')}${tail}`
  } catch {
    return `${transform(head.replace(/\/+$/, ''))}${tail}`
  }
}

function appendUrlPath(rawUrl: string, suffix: string): string {
  return mapUrlPath(rawUrl, (path) => `${path}${suffix}`)
}

function trimTrailingUrlPathSlash(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  const separatorIndex = trimmed.search(/[?#]/)
  if (separatorIndex === -1) {
    return trimmed.replace(/\/+$/, '')
  }

  const pathPart = trimmed.slice(0, separatorIndex).replace(/\/+$/, '')
  return `${pathPart}${trimmed.slice(separatorIndex)}`
}

function hasPathSuffix(rawUrl: string, suffix: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim())
    return parsed.pathname.replace(/\/+$/, '').endsWith(suffix)
  } catch {
    const withoutQuery = rawUrl.trim().split(/[?#]/, 1)[0] ?? ''
    return withoutQuery.replace(/\/+$/, '').endsWith(suffix)
  }
}

function replacePathSuffix(rawUrl: string, suffix: string, replacement: string): string {
  return mapUrlPath(rawUrl, (path) => path.endsWith(suffix)
    ? `${path.slice(0, -suffix.length)}${replacement}`
    : path)
}

function removePathSuffixForSdkBaseUrl(rawUrl: string, suffix: string): string {
  const trimmed = rawUrl.trim()
  assertSdkBaseUrlSupportsRouting(trimmed)
  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname.endsWith(suffix)) return normalizeBaseUrl(trimmed)

    parsed.pathname = pathname.slice(0, -suffix.length) || '/'
    return trimTrailingUrlPathSlash(parsed.toString())
  } catch {
    const pathPart = trimmed.split(/[?#]/, 1)[0] ?? trimmed
    const normalizedPath = pathPart.replace(/\/+$/, '')
    if (!normalizedPath.endsWith(suffix)) return normalizeBaseUrl(trimmed)
    return normalizedPath.slice(0, -suffix.length)
  }
}

/**
 * 判断端点是否为 Anthropic 协议形态（路径含 `/anthropic`）。
 *
 * 供「同一 provider 同时提供 OpenAI 与 Anthropic 两套入口」的供应商使用（典型是 DeepSeek）。
 * 这类供应商的协议必须跟随**端点形态**，不能写死 provider：
 * - 官方 Anthropic 入口（`…/anthropic`）→ Anthropic 协议
 * - 第三方 OpenAI 兼容网关（`…/v1`）→ OpenAI 协议
 *
 * 商业代管 relay（如 `…/v1/proxy`）由服务端路由决定协议，不适用本判定，
 * 调用方需自行排除。
 */
export function isAnthropicShapedEndpoint(baseUrl?: string): boolean {
  const raw = baseUrl?.trim()
  if (!raw) return false
  try {
    return new URL(raw).pathname.toLowerCase().includes('/anthropic')
  } catch {
    return raw.toLowerCase().includes('/anthropic')
  }
}

/**
 * 规范化 Anthropic Base URL（用于 Profer Chat 直接调用 API）
 *
 * 去除尾部斜杠，去除误填的 /messages 后缀，如果没有版本路径则追加 /v1。
 * 结果用于直接拼接 /messages 发起请求。
 *
 * 例如：
 * - "https://api.anthropic.com" → "https://api.anthropic.com/v1"
 * - "https://api.anthropic.com/v1" → 不变
 * - "https://proxy.example.com/v2/" → "https://proxy.example.com/v2"
 * - "https://proxy.example.com/v1/messages" → "https://proxy.example.com/v1"
 * - "https://proxy.example.com/v1/messages/" → "https://proxy.example.com/v1"
 * - "https://api.deepseek.com/anthropic" → 不变（已有非版本路径）
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return mapUrlPath(baseUrl, (path) => {
    const root = path.replace(/\/(messages|models)$/, '')
    return root || '/v1'
  })
}

/**
 * 规范化带版本路径的 Anthropic 兼容 Base URL。
 *
 * 某些网关以 `/anthropic` 作为协议根路径，但实际 API 仍位于 `/v1/messages`。
 * 没有版本路径时追加 `/v1`，已有版本路径（如 `/coding/v1`）则保持不变。
 * 例如：
 * - "https://api.minimaxi.com/anthropic" → "https://api.minimaxi.com/anthropic/v1"
 * - "https://api.minimaxi.com/anthropic/v1/messages" → "https://api.minimaxi.com/anthropic/v1"
 * - "https://api.deepseek.com/anthropic" → "https://api.deepseek.com/anthropic/v1"
 * - "https://api.kimi.com/coding/v1" → 不变（已有版本路径）
 */
export function normalizeVersionedAnthropicBaseUrl(baseUrl: string): string {
  return mapUrlPath(baseUrl, (path) => {
    const root = path.replace(/\/(messages|models)$/, '')
    return /\/v\d+$/.test(root) ? root : `${root}/v1`
  })
}

/**
 * 规范化 Anthropic Base URL（用于 Agent SDK 环境变量 ANTHROPIC_BASE_URL）
 *
 * SDK 内部会自动拼接 /v1/messages，所以这里需要去除用户误填的路径后缀，
 * 只保留根路径。
 *
 * 例如：
 * - "https://api.anthropic.com" → "https://api.anthropic.com"
 * - "https://api.anthropic.com/v1" → "https://api.anthropic.com"
 * - "https://api.anthropic.com/v1/messages" → "https://api.anthropic.com"
 * - "https://gateway.example.com/anthropic/v1/messages" → "https://gateway.example.com/anthropic"
 * - "https://gateway.example.com/anthropic/" → "https://gateway.example.com/anthropic"
 */
export function normalizeAnthropicBaseUrlForSdk(baseUrl: string): string {
  assertSdkBaseUrlSupportsRouting(baseUrl)
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v\d+\/messages$/, '')
    .replace(/\/v\d+$/, '')
}

/**
 * 规范化通用 Base URL
 *
 * 仅去除尾部斜杠，适用于 OpenAI / Google 等。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return trimTrailingUrlPathSlash(baseUrl)
}

/** 是否指向 DeepSeek 官方域名；第三方网关不得被官方默认值迁移逻辑覆盖。 */
export function isOfficialDeepSeekHost(baseUrl?: string): boolean {
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
export function isOfficialDeepSeekAgentUrl(baseUrl?: string): boolean {
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

export function isOfficialDeepSeekV1Url(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    return url.hostname === 'api.deepseek.com' && url.pathname.replace(/\/+$/, '') === '/v1'
  } catch {
    return baseUrl.trim().replace(/\/+$/, '') === 'https://api.deepseek.com/v1'
  }
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

/**
 * 推导 Agent（Anthropic 协议）实际消费的 Base URL。
 *
 * 渲染层（端点预览）与主进程（测试连接、模型发现、运行时凭据）必须共用这一份推导，
 * 否则表单上显示/校验的地址会和实际请求地址漂移。
 */
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

  // 用户显式填了主地址时优先于官方默认入口：否则 Pi-only 的 Anthropic 渠道指向
  // 自建网关时，Pi 请求会被静默打到官方地址，而能覆盖这个行为的 agentBaseUrl
  // 字段此前在 UI 上被隐藏（该字段现已对勾 Pi 的 Anthropic 协议渠道可见）。
  if (baseUrl?.trim() && PROVIDER_DEFAULT_AGENT_URLS[provider] && baseUrl.trim() !== PROVIDER_DEFAULT_URLS[provider]) {
    return normalizeBaseUrl(baseUrl)
  }

  // Pi 原生 API 渠道没有独立的 Anthropic Agent endpoint，必须复用用户配置的
  // Base URL；否则会把 undefined 传入模型注册层。
  return PROVIDER_DEFAULT_AGENT_URLS[provider]
    ?? (isAgentCompatibleProvider(provider) || PI_NATIVE_BASE_URL_PROVIDERS.has(provider)
      ? baseUrl?.trim()
      : undefined)
}

/**
 * 规范化 Gemini 原生协议的 Base URL（返回协议根）。
 *
 * 调用方会在后面自行拼 `/v1beta/…`，所以用户误填的版本段必须全部剥掉，否则会得到
 * `…/v1beta/v1beta/…`、`…/v1/v1beta/…` 这类 404 地址：
 * - 中转站和用户习惯把地址写成 OpenAI 兼容的 `…/v1`
 * - Google 文档和部分网关直接给 `…/v1beta` 或完整的 `…/v1beta/models`
 *
 * 只处理版本段本身；其它自定义前缀（如 `…/tenant/v2`）原样保留，
 * 网关可能把 Gemini 挂在自有路由下。
 *
 * 例如：
 * - "https://api.fluxlane.cn" → 不变
 * - "https://api.fluxlane.cn/v1/" → "https://api.fluxlane.cn"
 * - "https://gw.example.com/v1beta" → "https://gw.example.com"
 * - "https://gw.example.com/v1beta/models" → "https://gw.example.com"
 * - "https://gw.example.com/tenant/v1beta" → "https://gw.example.com/tenant"
 */
export function normalizeGoogleBaseUrl(baseUrl: string): string {
  return mapUrlPath(baseUrl, (path) => {
    if (path === '/v1') return '/'
    return path.replace(/\/v1beta(?:\/models)?$/i, '') || '/'
  })
}

/** SDK 使用字符串拼接请求路径，不能安全传递 Base URL 上的 query/hash。 */
export function assertSdkBaseUrlSupportsRouting(baseUrl: string): void {
  if (/[?#]/.test(baseUrl.trim())) {
    // 不回显地址，query 中可能含路由凭据。
    throw new Error('Agent SDK 暂不支持端点中的 query/hash 路由，请使用不含 ? 或 # 的协议根地址；Chat 与模型发现仍可使用原地址')
  }
}

/**
 * 规范化 OpenAI 兼容 Base URL（用于 Pi Agent runtime）。
 *
 * Pi / OpenAI client 会自行拼接 /chat/completions 或 /responses；custom / OpenAI Responses
 * 渠道若保存的是完整端点，这里需要还原成协议根地址，避免重复拼接。
 */
export function normalizeOpenAIBaseUrlForSdk(baseUrl: string): string {
  assertSdkBaseUrlSupportsRouting(baseUrl)
  if (hasPathSuffix(baseUrl, '/chat/completions')) {
    return removePathSuffixForSdkBaseUrl(baseUrl, '/chat/completions')
  }
  if (hasPathSuffix(baseUrl, '/responses')) {
    return removePathSuffixForSdkBaseUrl(baseUrl, '/responses')
  }
  return normalizeBaseUrl(baseUrl)
}

/**
 * 取 URL 的 path（不含 query/hash）。
 *
 * 无法按 URL 解析时退化为字符串切分，与 mapUrlPath 的容错保持一致，
 * 便于对 `host/v1` 这类缺 scheme 的输入做形态判断。
 */
function extractUrlPath(rawUrl: string): string {
  const head = rawUrl.trim().split(/[?#]/, 1)[0] ?? ''
  try {
    return new URL(head).pathname
  } catch {
    return head.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^[^/]*/, '')
  }
}

/**
 * 解析 OpenAI Chat Completions 请求地址。
 *
 * 通用兼容渠道（custom）允许直接填写完整请求端点，此时原样使用。
 * 但同一个 Base URL 还要供 Pi（Agent）消费，而 Pi 需要的是**协议根地址**
 * （它自行拼接 /chat/completions，并在注册前剥掉用户误填的端点后缀），
 * 因此用户把地址配成 `/v1` 这类协议根是常见且合理的写法。
 * 而直接 POST 协议根会落到站点路由上：New API / one-api 等 Go 网关返回
 * `404 page not found`，部分中转站直接返回站点首页 HTML。
 * 所以这里只对**形态明确的协议根**补全端点，其它自定义路由一律不猜：
 * - "https://api.example.com/v1" → "https://api.example.com/v1/chat/completions"
 * - "https://api.example.com" → "https://api.example.com/v1/chat/completions"
 * - "https://gateway.example.com/v1/proxy/chat" → 原样使用（商业代管 relay 等自定义路由）
 * - custom 已填完整端点 → 原样使用（去尾斜杠）
 */
export function resolveOpenAIChatCompletionsUrl(baseUrl: string, provider: ProviderType = 'openai'): string {
  if (provider === 'ollama') {
    return mapUrlPath(baseUrl, (path) => `${path.replace(/\/v1$/, '')}/v1/chat/completions`)
  }
  if (provider === 'custom') {
    const normalized = trimTrailingUrlPathSlash(baseUrl)
    // 未配置地址的渠道保持空值语义，不凭空造出相对路径
    if (!normalized) return normalized
    if (hasPathSuffix(normalized, '/chat/completions')) return normalized
    const path = extractUrlPath(normalized)
    // 裸域名/站点根：按 OpenAI 兼容网关的通行约定补 /v1/chat/completions
    if (path === '' || path === '/') return appendUrlPath(normalized, '/v1/chat/completions')
    // 版本根（/v1、/api/v1 等）：只补端点后缀
    if (/\/v\d+$/.test(path)) return appendUrlPath(normalized, '/chat/completions')
    return normalized
  }
  if (hasPathSuffix(baseUrl, '/chat/completions')) {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  return appendUrlPath(baseUrl, '/chat/completions')
}

/**
 * 解析 OpenAI Responses 请求地址。
 *
 * 内置 OpenAI Responses 渠道允许填写协议根地址或完整 /responses 端点。
 */
export function resolveOpenAIResponsesUrl(baseUrl: string, _provider: ProviderType = 'openai-responses'): string {
  if (hasPathSuffix(baseUrl, '/responses')) {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  return appendUrlPath(baseUrl, '/responses')
}

/**
 * 解析 OpenAI Models 地址。
 *
 * 当用户把兼容格式配置为完整 /chat/completions 或 /responses 端点时，模型列表需要回到同级 /models。
 */
export function resolveOpenAIModelsUrl(baseUrl: string): string {
  if (hasPathSuffix(baseUrl, '/chat/completions')) {
    return replacePathSuffix(baseUrl, '/chat/completions', '/models')
  }
  if (hasPathSuffix(baseUrl, '/responses')) {
    return replacePathSuffix(baseUrl, '/responses', '/models')
  }
  if (hasPathSuffix(baseUrl, '/models')) return trimTrailingUrlPathSlash(baseUrl)
  return appendUrlPath(baseUrl, '/models')
}

/**
 * 根据 Anthropic 协议供应商类型选择对应的 URL 规范化策略。
 *
 * @deprecated 运行时与 Chat 的端点推导已统一到 resolveAnthropicMessagesUrl /
 * resolveAnthropicModelsUrl（chat/sdk 两种模式），本函数仅保留给历史调用方与
 * 单测，新代码不要再直接使用，否则会重新引入「两套语义」。
 *
 * 仅适用于走 Anthropic 协议且允许填写协议根路径的内置供应商。
 *
 * DeepSeek / Kimi 等以 `/anthropic` 为协议根路径的供应商，实际端点仍位于
 * `/anthropic/v1/messages`，因此统一走 normalizeVersionedAnthropicBaseUrl 按需补 `/v1`
 * （已含版本路径如 `/coding/v1` 的不会重复追加），与 Agent SDK 自动拼接 /v1/messages 的行为保持一致。
 */
export function normalizeAnthropicProviderUrl(baseUrl: string, provider: ProviderType): string {
  if (provider === 'ollama') {
    return normalizeVersionedAnthropicBaseUrl(baseUrl)
  }
  if (
    provider === 'minimax'
    || provider === 'xiaomi'
    || provider === 'xiaomi-token-plan'
    || provider === 'qwen-anthropic'
    || provider === 'zhipu-coding'
    || provider === 'zhipu-coding-team'
    || provider === 'ark-coding-plan'
    || provider === 'deepseek'
    || provider === 'kimi-api'
    || provider === 'kimi-coding'
  ) {
    return normalizeVersionedAnthropicBaseUrl(baseUrl)
  }
  return normalizeAnthropicBaseUrl(baseUrl)
}

/**
 * Anthropic 端点解析模式。
 *
 * - `chat`：Profer 自己发请求（Chat 适配器 / 连接测试 / 模型发现）。可以直接带
 *   query/hash 路由，也允许用户填写完整端点。
 * - `sdk`：Claude / Pi 的 Anthropic SDK 消费的地址。SDK 只接受协议根并自行拼接
 *   `/v1/messages`，所以必须按 SDK 语义推导，且不能带 query/hash。
 */
export type AnthropicEndpointMode = 'chat' | 'sdk'

/** 小米系列渠道的 Anthropic 入口固定在 `/anthropic` 下（历史 Chat 行为）。 */
function isXiaomiAnthropicProvider(provider: ProviderType): boolean {
  return provider === 'xiaomi' || provider === 'xiaomi-token-plan'
}

/**
 * Chat 直连使用的 Anthropic 协议根（含版本段）。
 *
 * 只处理 pathname，query/hash 路由原样留在端点末尾：
 * - 裸域名 → 补 `/v1`
 * - `/anthropic` → `/anthropic/v1`
 * - 已含版本段（`/coding/v1`、`/proxy/v2`）→ 保持不变
 * - 小米系列 → 固定纠正到 `/anthropic/v1`（用户常把 OpenAI 兼容的 `/v1` 填进来）
 */
function resolveChatAnthropicVersionedRoot(baseUrl: string, provider: ProviderType): string {
  if (isXiaomiAnthropicProvider(provider)) {
    return mapUrlPath(baseUrl, () => '/anthropic/v1')
  }
  return mapUrlPath(baseUrl, (path) => {
    const root = path.replace(/\/(messages|models)$/, '')
    if (/\/v\d+$/.test(root)) return root || '/'
    return `${root === '/' ? '' : root}/v1`
  })
}

/**
 * 统一的 Anthropic 协议端点解析（messages / models）。
 *
 * 历史上 Chat 走 `normalizeAnthropicProviderUrl + /messages`，而 Agent/Pi 走
 * `normalizeAnthropicBaseUrlForSdk + /v1/messages`，两套语义并存导致同一个渠道在
 * Chat / Agent 下打到不同路径（`/anthropic/messages` vs `/anthropic/v1/messages`，
 * 甚至 anthropic-compatible 直接请求协议根）。本函数是唯一事实源：
 * - `sdk` 模式严格等价于 Claude/Pi SDK：`normalizeAnthropicBaseUrlForSdk(base) + /v1/<kind>`
 * - `chat` 模式与 SDK 对齐（协议根补 `/v1`），但保留 Chat 的两项能力：
 *   完整端点原样使用、query/hash 路由可用
 */
function resolveAnthropicProtocolUrl(
  baseUrl: string,
  provider: ProviderType,
  kind: 'messages' | 'models',
  mode: AnthropicEndpointMode,
): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return trimmed

  if (mode === 'sdk') {
    // SDK 自行拼接 /v1/<kind>；normalizeAnthropicBaseUrlForSdk 同时拒绝 query/hash 路由。
    return appendUrlPath(normalizeAnthropicBaseUrlForSdk(trimmed), `/v1/${kind}`)
  }

  // Chat 允许用户直接填写完整端点（anthropic-compatible 迁移后就是这样存储的）。
  if (hasPathSuffix(trimmed, '/messages') || hasPathSuffix(trimmed, '/models')) {
    const current = hasPathSuffix(trimmed, '/messages') ? '/messages' : '/models'
    return trimTrailingUrlPathSlash(replacePathSuffix(trimmed, current, `/${kind}`))
  }

  return appendUrlPath(resolveChatAnthropicVersionedRoot(trimmed, provider), `/${kind}`)
}

/**
 * 解析 Anthropic Messages 请求地址。
 *
 * 默认 `chat` 模式供 Chat 适配器、连接测试、模型发现使用；`sdk` 模式供 Claude/Pi
 * 运行时（测试连接、目录发现）使用，两者语义一致，见 resolveAnthropicProtocolUrl。
 *
 * 例如（chat 与 sdk 结果一致）：
 * - "https://gw/anthropic" → "https://gw/anthropic/v1/messages"
 * - "https://gw" → "https://gw/v1/messages"
 * - "https://gw/v1" → "https://gw/v1/messages"
 * - "https://gw/v1/messages" → "https://gw/v1/messages"
 */
export function resolveAnthropicMessagesUrl(
  baseUrl: string,
  provider: ProviderType,
  mode: AnthropicEndpointMode = 'chat',
): string {
  return resolveAnthropicProtocolUrl(baseUrl, provider, 'messages', mode)
}

/**
 * 解析 Anthropic Models 地址。
 *
 * 与 resolveAnthropicMessagesUrl 共用同一份推导：Chat 从完整端点换同级端点，
 * SDK 模式从协议根拼 `/v1/models`。
 */
export function resolveAnthropicModelsUrl(
  baseUrl: string,
  provider: ProviderType,
  mode: AnthropicEndpointMode = 'chat',
): string {
  return resolveAnthropicProtocolUrl(baseUrl, provider, 'models', mode)
}

/**
 * 将旧版本（v1）存储的通用兼容渠道 Base URL 一次性迁移为完整请求端点。
 *
 * 背景：custom / anthropic-compatible 两类通用兼容渠道，旧版本把存储值当作 Base URL，
 * 运行时再自动补全 /chat/completions 或 /v1/messages。新版本改为「用户填写完整请求地址，
 * 原样使用」。若不迁移，存量渠道升级后会向缺少端点后缀的地址发请求而失败（通常 404）。
 *
 * 本函数把存量 Base URL 补全为旧版本「实际请求过」的完整 URL，使升级后的运行时行为与升级前一致：
 * - custom（OpenAI 兼容）：复现旧 OpenAIAdapter 的 `normalizeBaseUrl(base) + '/chat/completions'`
 * - anthropic-compatible：复现旧 normalizeAnthropicProviderUrl 的 versioned 分支
 *   `normalizeVersionedAnthropicBaseUrl(base) + '/messages'`
 *
 * 幂等保证：空值、非这两类 provider、以及已经是完整端点的值都原样返回，可安全重复执行。
 *
 * 注意：anthropic-compatible 渠道的 baseUrl 同时被 Agent SDK 路径
 * （normalizeAnthropicBaseUrlForSdk）消费，该函数会剥除 /v\d+/messages 后缀，
 * 因此迁移成完整 /v1/messages 端点后 SDK 路径仍能还原出与升级前一致的根地址，互不影响。
 */
export function migrateCompatibleChannelBaseUrl(baseUrl: string, provider: ProviderType): string {
  const trimmed = baseUrl.trim()
  // 空 Base URL（如未配置的渠道）无需迁移
  if (trimmed === '') {
    return baseUrl
  }

  if (provider === 'custom') {
    // 已是完整端点则不重复追加
    if (hasPathSuffix(trimmed, '/chat/completions')) {
      return trimTrailingUrlPathSlash(trimmed)
    }
    return appendUrlPath(trimmed, '/chat/completions')
  }

  if (provider === 'anthropic-compatible') {
    if (hasPathSuffix(trimmed, '/messages')) {
      return trimTrailingUrlPathSlash(trimmed)
    }
    return appendUrlPath(normalizeVersionedAnthropicBaseUrl(trimmed), '/messages')
  }

  // 其他 provider 的 URL 语义未改变，原样返回
  return baseUrl
}
