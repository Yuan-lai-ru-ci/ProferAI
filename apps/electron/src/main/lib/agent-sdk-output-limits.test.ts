import { describe, expect, test } from 'bun:test'
import { getAgentSdkMaxOutputTokens } from './agent-sdk-output-limits'

describe('Agent SDK 输出 token 上限', () => {
  test('Given Anthropic 原生渠道 When 构建 SDK env Then 保留 Claude 64K 输出上限', () => {
    expect(getAgentSdkMaxOutputTokens('anthropic')).toBe('64000')
  })

  test.each(['kimi-coding', 'zhipu-coding', 'ark-coding-plan', 'qwen-anthropic', 'anthropic-compatible'] as const)(
    'Given 非 Claude 兼容渠道 %s When 构建 SDK env Then 不超过常见 32768 max_tokens 限制',
    (provider) => {
      expect(getAgentSdkMaxOutputTokens(provider)).toBe('32768')
    },
  )
})
