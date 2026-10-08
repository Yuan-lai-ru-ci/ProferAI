/**
 * Provider 适配器注册表
 *
 * 集中管理所有已注册的供应商适配器，
 * 通过 ProviderType 查找对应的适配器实例。
 */

import type { ProviderType } from '@profer/shared'
import type { ProviderAdapter } from './types.ts'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'

// 导出所有类型和工具
export * from './types.ts'
export * from './sse-reader.ts'
export * from './url-utils.ts'
export * from './thinking-capability.ts'
export * from './user-agent.ts'
export * from './insufficient-credits.ts'

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
export function getAdapter(provider: ProviderType): ProviderAdapter {
  const createAdapter = adapterRegistry.get(provider)
  if (!createAdapter) {
    throw new Error(`不支持的供应商: ${provider}。你可能过去使用的是 Profer 商业版，请重新下载商业版覆盖安装，当前版本为开源版本。`)
  }
  return createAdapter()
}
