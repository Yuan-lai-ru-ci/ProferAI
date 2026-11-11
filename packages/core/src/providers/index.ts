/**
 * Provider 适配器注册表
 *
 * 集中管理所有已注册的供应商适配器，
 * 通过 ProviderType 查找对应的适配器实例。
 */

import type { ProviderType, XaiApiProtocol } from '@profer/shared'
import { PROVIDER_CAPABILITIES, resolveProviderNativeProtocol } from '@profer/shared'
import type { ProviderAdapter } from './types.ts'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'
import { normalizeOpenAIBaseUrlForSdk } from './url-utils.ts'

// 导出所有类型和工具
export * from './types.ts'
export * from './sse-reader.ts'
export * from './url-utils.ts'
export * from './thinking-capability.ts'
export * from './user-agent.ts'
// 额度不足（402 → 「请充值」）是商业版语义：开源版没有额度体系，也不该把这段
// 解析与文案打进开源包。因此**刻意不从 barrel 导出**，只允许商业侧用深路径
// `@profer/core/providers/insufficient-credits` 引用。

// 导出适配器类
export { AnthropicAdapter } from './anthropic-adapter.ts'
export { OpenAIAdapter } from './openai-adapter.ts'
export { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
export { GoogleAdapter } from './google-adapter.ts'

/** 供应商适配器注册表 */
const adapterRegistry = new Map<ProviderType, () => ProviderAdapter>([
  ['anthropic', () => new AnthropicAdapter()],
  ['anthropic-compatible', () => new AnthropicAdapter('anthropic-compatible')],
  ['openai', () => new OpenAIAdapter()],
  ['openai-responses', () => new OpenAIResponsesAdapter()],
  ['xai', () => new OpenAIResponsesAdapter('xai')],
  ['deepseek', () => new OpenAIAdapter('deepseek')],
  ['kimi-api', () => new AnthropicAdapter('kimi-api')],
  ['kimi-coding', () => new AnthropicAdapter('kimi-coding')],
  ['opencode-go-openai', () => new OpenAIAdapter('opencode-go-openai')],
  ['zhipu', () => new OpenAIAdapter('zhipu')],
  ['zhipu-coding', () => new AnthropicAdapter('zhipu-coding')],
  ['zhipu-coding-team', () => new AnthropicAdapter('zhipu-coding-team')],
  ['ark-coding-plan', () => new AnthropicAdapter('ark-coding-plan')],
  ['qwen-anthropic', () => new AnthropicAdapter('qwen-anthropic')],
  ['minimax', () => new AnthropicAdapter('minimax')],
  ['ollama', () => new OpenAIAdapter('ollama')],
  ['doubao', () => new OpenAIAdapter('doubao')],
  ['qwen', () => new OpenAIAdapter('qwen')],
  ['xiaomi', () => new AnthropicAdapter('xiaomi')],
  ['xiaomi-token-plan', () => new AnthropicAdapter('xiaomi-token-plan')],
  ['custom', () => new OpenAIAdapter('custom')],
  ['google', () => new GoogleAdapter()],
])

/**
 * 根据供应商类型获取适配器
 *
 * @param provider 供应商类型
 * @returns 对应的适配器实例
 * @throws Error 如果供应商类型不支持
 */
export function getAdapter(provider: ProviderType, xaiApiProtocol?: XaiApiProtocol, baseUrl?: string): ProviderAdapter {
  // xAI 渠道的协议由用户在渠道上选择：官方默认 Responses，只支持 Chat Completions
  // 的第三方中转可切到 OpenAI 兼容适配器，不再要求中转去实现 /responses。
  if (provider === 'xai' && xaiApiProtocol === 'chat-completions') return new OpenAIAdapter('xai')
  // 真实协议只判定一次：端点形态（/responses）与官方厂商端点共用 shared 的同一份事实源，
  // 避免 Chat 与 Pi 运行时/连接测试各自维护一套 host 判断而漂移。
  const nativeProtocol = resolveProviderNativeProtocol(provider, baseUrl, xaiApiProtocol)
  // 用户把完整 /responses 端点填进了 OpenAI 兼容渠道时，端点形态会覆盖静态归属：
  // 否则请求以 Chat Completions 的 messages 请求体打到 Responses 端点，
  // 网关通常回 200 + 空流，界面上只表现为「连上了但没输出」。
  if (
    provider !== 'openai-responses' &&
    provider !== 'openai-codex' &&
    nativeProtocol === 'openai-responses'
  ) {
    return new OpenAIResponsesAdapter(provider)
  }
  const createAdapter = adapterRegistry.get(provider)
  if (!createAdapter) {
    throw new Error(`不支持的供应商: ${provider}。你可能过去使用的是 Profer 商业版，请重新下载商业版覆盖安装，当前版本为开源版本。`)
  }

  // 官方厂商端点覆盖：custom 渠道指向 Anthropic / Google 官方 API 时，静态归属仍是
  // OpenAI 兼容，但对方根本没有 /chat/completions，请求必然 404（表现为「Agent 能用、
  // Chat 不通」）。这里复用与 Pi 运行时同一份端点表，只对静态协议为 openai-completions
  // 的渠道生效，因此 deepseek 这类自带 Anthropic 入口的供应商不受影响。
  // Mistral 故意不覆盖：它的原生对话端点与 OpenAI 路径一致，Chat 请求体
  // （model/messages/stream/tools）也被接受，切协议只会多出一份要维护的转换。
  if (PROVIDER_CAPABILITIES[provider].nativeProtocol === 'openai-completions') {
    if (nativeProtocol === 'anthropic-messages') {
      // 按官方 Anthropic 语义构造：端点推导（协议根补 /v1/messages）、双认证头、
      // 思考协议都走 anthropic 分支。若沿用 'custom'，Claude 5.x 会收到旧版
      // budget_tokens 而 400（见 detectThinkingCapability 的 providerType 兜底）。
      return new AnthropicAdapter('anthropic')
    }
    if (nativeProtocol === 'google-generative-ai') {
      // GoogleAdapter 内部已 normalizeGoogleBaseUrl 并拼 /v1beta/models/…，裸域名可用。
      return new GoogleAdapter()
    }
  }

  return createAdapter()
}

/**
 * 标题请求的 Base URL 归一化。
 *
 * 主链路（Pi 注册层）会先用 `normalizeOpenAIBaseUrlForSdk` 把用户误填的完整端点
 * 还原成协议根，再由 SDK 自行拼接 `/chat/completions`；标题请求是旁路，之前直接
 * 把 `/v1/responses` 当成 Chat Completions 端点，导致同一个渠道「聊天正常、标题失败」。
 *
 * 这里复用同一份归一化，保证标题与主链路请求落在同一个地址上。只对 OpenAI 兼容
 * 族生效；Anthropic/Google 与 OAuth 订阅渠道的地址语义不同，保持原样。
 */
export function resolveTitleBaseUrl(
  provider: ProviderType,
  baseUrl?: string,
  xaiApiProtocol?: XaiApiProtocol,
): string | undefined {
  const raw = baseUrl?.trim()
  if (!raw) return baseUrl
  if (provider === 'xai') {
    // Responses 渠道保持原样（历史行为）；Chat Completions 渠道需要把误填的
    // /responses 或 /chat/completions 还原成协议根，避免标题请求拼出双层端点。
    if (xaiApiProtocol !== 'chat-completions') return baseUrl
    try {
      return normalizeOpenAIBaseUrlForSdk(raw)
    } catch {
      return baseUrl
    }
  }
  const protocol = PROVIDER_CAPABILITIES[provider]?.nativeProtocol
  const openAICompatible = protocol === 'openai-completions' || protocol === 'openai-responses'
  if (!openAICompatible || provider === 'ollama' || provider === 'openai-codex') return baseUrl
  try {
    return normalizeOpenAIBaseUrlForSdk(raw)
  } catch {
    // 带 query/hash 的自定义路由不能安全归一化：保留原样，让既有报错链路处理。
    return baseUrl
  }
}
