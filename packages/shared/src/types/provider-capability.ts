/**
 * Per-provider 能力描述符：模型配置的单一事实源。
 *
 * 历史上「这个 provider 说什么协议、默认地址是什么、走哪条 Chat 路径、支持哪些
 * Agent 内核」被 AGENT_COMPATIBLE_PROVIDERS / PI_NATIVE_BASE_URL_PROVIDERS /
 * ANTHROPIC_PROTOCOL_PROVIDERS / PROVIDER_CHAT_PATHS / normalizePiApi /
 * inferReasoningTransport / channel-model-groups 等至少六张平行表分别回答，
 * 且已产生实测漂移（ark-coding-plan 在 renderer 被误判为 OpenAI 协议）。
 * 本文件把每个 ProviderType 的静态能力收敛到一张表，其余消费方一律派生。
 *
 * 注意：这里只声明**静态归属**。DeepSeek / Ollama 这类「协议随用户填的端点形态
 * 变化」的 provider，运行时的最终协议仍由 pi-model-registry 的 URL 形态嗅探在
 * 本表基础上修正（见 resolveProviderNativeProtocol 的注释）。
 */

// 仅类型依赖 channel.ts；运行时依赖方向是 channel.ts → 本文件，不构成循环。
import type { ProviderType } from './channel'

/** 请求协议族；与 pi-ai 的 Api 及 reasoning 的 ReasoningTransport 对齐。 */
export type ProviderNativeProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

/** 模型目录来源。 */
export type ProviderCatalogKind =
  /** 供应商公网 API 拉取（/models 或等价）。 */
  | 'vendor-api'
  /** OAuth 订阅的内置目录（Codex / xAI 订阅），非用户可拉取的 vendor API。 */
  | 'oauth-builtin'
  /** 服务端代管同步（serverManaged 官方渠道）。 */
  | 'server-sync'
  /** 仅用户手填（custom / 本地 ollama 等无公网目录或目录不可靠）。 */
  | 'manual'

export interface ProviderCapability {
  readonly provider: ProviderType
  /**
   * 该 provider 的「原生」请求协议：未做 URL 形态嗅探时的静态归属。
   * 对 deepseek / ollama 这只是默认值，真实协议还要看端点形态（见下）。
   */
  readonly nativeProtocol: ProviderNativeProtocol
  /** 该协议是否 Anthropic Messages 族（共用 /v1/messages 形态端点）。 */
  readonly isAnthropicProtocol: boolean
  /** 是否可勾选 Claude 内核（Claude 只懂 anthropic-messages）。 */
  readonly supportsClaude: boolean
  /** 是否可勾选 Pi 内核。 */
  readonly supportsPi: boolean
  /** Chat 补全的端点路径（Base URL 预览用）。 */
  readonly chatPath: string
  /**
   * Chat/展示维度的协议：模型选择器分组标签、渠道列表标识用。
   * 与 Agent 原生协议是两个维度——DeepSeek 的 Chat 走 OpenAI 兼容但 Agent
   * 默认走 Anthropic，展示维度呈现 openai。由 chatPath 派生，不单独维护。
   */
  readonly chatProtocol: 'openai' | 'anthropic' | 'google'
  /** 模型目录来源。 */
  readonly catalogKind: ProviderCatalogKind
  /**
   * 协议是否随用户填的端点形态变化（deepseek 双协议、ollama 远程走 OpenAI）。
   * 为 true 时 nativeProtocol 只是默认，运行时须以 URL 嗅探结果为准。
   */
  readonly protocolVariesByEndpoint: boolean
}

function cap(
  provider: ProviderType,
  nativeProtocol: ProviderNativeProtocol,
  chatPath: string,
  catalogKind: ProviderCatalogKind,
  overrides: Partial<Omit<ProviderCapability, 'provider' | 'nativeProtocol' | 'chatPath' | 'catalogKind'>> = {},
): ProviderCapability {
  const isAnthropicProtocol = nativeProtocol === 'anthropic-messages'
  const chatProtocol: ProviderCapability['chatProtocol'] = nativeProtocol === 'google-generative-ai'
    ? 'google'
    : chatPath.includes('messages') ? 'anthropic' : 'openai'
  return {
    provider,
    nativeProtocol,
    isAnthropicProtocol,
    chatProtocol,
    // Claude 只懂 anthropic-messages；xAI / openai-codex 这类订阅渠道即使有
    // anthropic 形态地址也不给 Claude（与历史白名单行为等价）。
    supportsClaude: isAnthropicProtocol,
    supportsPi: true,
    chatPath,
    catalogKind,
    protocolVariesByEndpoint: false,
    ...overrides,
  }
}

/** 23 个 ProviderType 的能力描述符表。键序与 PROVIDER_DEFAULT_URLS 对齐。 */
export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderType, ProviderCapability>> = {
  anthropic: cap('anthropic', 'anthropic-messages', '/v1/messages', 'vendor-api'),
  'anthropic-compatible': cap('anthropic-compatible', 'anthropic-messages', '/v1/messages', 'manual'),
  openai: cap('openai', 'openai-completions', '/chat/completions', 'vendor-api'),
  'openai-responses': cap('openai-responses', 'openai-responses', '/responses', 'vendor-api'),
  deepseek: cap('deepseek', 'anthropic-messages', '/chat/completions', 'vendor-api', { protocolVariesByEndpoint: true }),
  google: cap('google', 'google-generative-ai', '/v1beta/models/{model}:generateContent', 'vendor-api', { supportsClaude: false }),
  'kimi-api': cap('kimi-api', 'anthropic-messages', '/messages', 'vendor-api'),
  'kimi-coding': cap('kimi-coding', 'anthropic-messages', '/messages', 'vendor-api'),
  'opencode-go-openai': cap('opencode-go-openai', 'openai-completions', '/chat/completions', 'vendor-api', { supportsClaude: false }),
  zhipu: cap('zhipu', 'openai-completions', '/chat/completions', 'vendor-api', { supportsClaude: false }),
  'zhipu-coding': cap('zhipu-coding', 'anthropic-messages', '/messages', 'vendor-api'),
  'zhipu-coding-team': cap('zhipu-coding-team', 'anthropic-messages', '/messages', 'vendor-api'),
  'ark-coding-plan': cap('ark-coding-plan', 'anthropic-messages', '/messages', 'vendor-api'),
  minimax: cap('minimax', 'anthropic-messages', '/v1/messages', 'vendor-api'),
  doubao: cap('doubao', 'openai-completions', '/chat/completions', 'vendor-api', { supportsClaude: false }),
  qwen: cap('qwen', 'openai-completions', '/chat/completions', 'vendor-api', { supportsClaude: false }),
  'qwen-anthropic': cap('qwen-anthropic', 'anthropic-messages', '/messages', 'vendor-api'),
  xiaomi: cap('xiaomi', 'anthropic-messages', '/v1/messages', 'vendor-api'),
  'xiaomi-token-plan': cap('xiaomi-token-plan', 'anthropic-messages', '/v1/messages', 'vendor-api'),
  'openai-codex': cap('openai-codex', 'openai-responses', '', 'oauth-builtin', { supportsClaude: false }),
  xai: cap('xai', 'openai-responses', '/responses', 'vendor-api', { supportsClaude: false }),
  ollama: cap('ollama', 'anthropic-messages', '/v1/chat/completions', 'manual', { protocolVariesByEndpoint: true }),
  custom: cap('custom', 'openai-completions', '/chat/completions', 'manual', { supportsClaude: false }),
}

/** 读取 provider 的能力描述符。 */
export function getProviderCapability(provider: ProviderType): ProviderCapability {
  return PROVIDER_CAPABILITIES[provider]
}

/**
 * provider 的静态原生协议（不做 URL 形态嗅探）。
 *
 * 渲染层分组、标签、能力矩阵等「只看 provider 不看端点」的场景用这个；
 * 运行时真实请求协议的最终判定（含 deepseek/ollama 端点嗅探）仍在
 * pi-model-registry 的 normalizePiApi，它基于本表的默认值做形态修正。
 */
export function getProviderNativeProtocol(provider: ProviderType): ProviderNativeProtocol {
  return PROVIDER_CAPABILITIES[provider].nativeProtocol
}

/** provider 是否走 Anthropic Messages 协议族（静态默认）。 */
export function isAnthropicProtocolProvider(provider: ProviderType): boolean {
  return PROVIDER_CAPABILITIES[provider].isAnthropicProtocol
}

/**
 * Chat/展示维度的协议（模型选择器分组、渠道列表标签）。
 * 与 Agent 原生协议分离：DeepSeek/Ollama 展示为 openai，但其 Agent 可走 Anthropic。
 */
export function getProviderChatProtocol(provider: ProviderType): 'openai' | 'anthropic' | 'google' {
  return PROVIDER_CAPABILITIES[provider].chatProtocol
}

/** 地址路径是否含 /anthropic 子串（轻量实现，与 core 的 isAnthropicShapedEndpoint 等价）。 */
function isAnthropicShaped(baseUrl?: string): boolean {
  const raw = baseUrl?.trim()
  if (!raw) return false
  try {
    return new URL(raw).pathname.toLowerCase().includes('/anthropic')
  } catch {
    return raw.toLowerCase().includes('/anthropic')
  }
}

/** 商业代管 relay（`…/v1/proxy`）由服务端路由决定协议，不适用端点形态推断。 */
function isRelayProxy(baseUrl: string): boolean {
  return baseUrl.trim().replace(/\/+$/, '').endsWith('/v1/proxy')
}

/** 是否本机 Ollama 地址（按 hostname 判定）。共享给各运行时,替代两处逐字重复。 */
export function isLocalOllamaBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * 解析 provider 在指定端点下的真实原生协议（含端点形态嗅探）。
 *
 * 这是 normalizePiApi（Pi 请求协议）与 inferReasoningTransport（reasoning 协议）
 * 共同的上游事实源：渲染层思考档位菜单与运行时请求注入必须用同一份判定，
 * 否则 deepseek 接第三方 OpenAI 网关时会出现「菜单显示档位、实际注入被跳过」
 * 的静默无效。绝大多数 provider 直接返回静态 nativeProtocol；只有
 * protocolVariesByEndpoint 的 deepseek / ollama 需要看 baseUrl。
 */
export function resolveProviderNativeProtocol(provider: ProviderType, baseUrl?: string): ProviderNativeProtocol {
  const capability = PROVIDER_CAPABILITIES[provider]
  if (provider === 'ollama') {
    // 远程 Ollama 走 OpenAI 兼容；本机保持静态默认（anthropic-messages 供 Agent）。
    return isLocalOllamaBaseUrl(baseUrl) ? capability.nativeProtocol : 'openai-completions'
  }
  if (provider === 'deepseek') {
    // 商业 relay 或显式 /anthropic 端点保持静态默认；其余第三方网关走 OpenAI。
    if (baseUrl?.trim() && !isRelayProxy(baseUrl) && !isAnthropicShaped(baseUrl)) {
      return 'openai-completions'
    }
    return capability.nativeProtocol
  }
  return capability.nativeProtocol
}
