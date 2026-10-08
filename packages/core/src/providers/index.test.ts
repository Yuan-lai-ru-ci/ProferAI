import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@profer/shared'
import { getAdapter } from './index.ts'

describe('provider adapter instances', () => {
  test('每次获取 Anthropic adapter 都是独立实例，避免流式 block 状态跨请求污染', () => {
    expect(getAdapter('anthropic')).not.toBe(getAdapter('anthropic'))
  })

  test('每次获取 Google adapter 都是独立实例，避免工具计数器跨请求污染', () => {
    expect(getAdapter('google')).not.toBe(getAdapter('google'))
  })
})
  test('23 种 Provider：22 个 Chat adapter 与 Pi-only Codex 边界', () => {
    const providers: ProviderType[] = [
      'anthropic', 'anthropic-compatible', 'openai', 'openai-responses', 'deepseek', 'google',
      'kimi-api', 'kimi-coding', 'opencode-go-openai', 'zhipu', 'zhipu-coding', 'zhipu-coding-team',
      'ark-coding-plan', 'minimax', 'doubao', 'qwen', 'qwen-anthropic', 'xiaomi', 'xiaomi-token-plan',
      'openai-codex', 'xai', 'ollama', 'custom',
    ]
    expect(providers).toHaveLength(23)
    for (const provider of providers.filter((item) => item !== 'openai-codex')) expect(() => getAdapter(provider)).not.toThrow()
    expect(() => getAdapter('openai-codex')).toThrow('不支持的供应商')
  })
