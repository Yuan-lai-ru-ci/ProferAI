import { describe, expect, test } from 'bun:test'
import { injectCodexFastMode, withCodexFastModeServiceTier } from './pi-codex-fast-mode'
import { injectOpenAIThinkingLevel, injectDeepSeekV4ThinkingSettings } from './pi-codex-request-settings'

describe('Pi Codex Fast Mode', () => {
  test.each(['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'Given supported %s When injecting Then requests priority tier',
    (model) => {
      expect(injectCodexFastMode({ model })).toEqual({ model, service_tier: 'priority' })
    },
  )

  test('Given unsupported model When injecting Then leaves payload unchanged', () => {
    const payload = { model: 'gpt-5.4-mini' }
    expect(injectCodexFastMode(payload)).toBe(payload)
  })

  test('Given existing service tier When injecting Then Fast Mode overrides it', () => {
    expect(injectCodexFastMode({ model: 'gpt-5.6-terra', service_tier: 'flex' })).toEqual({
      model: 'gpt-5.6-terra',
      service_tier: 'priority',
    })
  })

  test('Given provider stream options When applying Fast Mode Then preserves priority tier for cost accounting', () => {
    expect(withCodexFastModeServiceTier({ transport: 'websocket' })).toEqual({
      transport: 'websocket',
      serviceTier: 'priority',
    })
  })

  test('Given non-object payload When injecting Then leaves payload unchanged', () => {
    expect(injectCodexFastMode('not-a-request')).toBe('not-a-request')
  })
})

// #1268: GPT-5.x 推理档位 — reasoning.effort 注入
describe('Pi Codex Thinking Level', () => {
  test.each([
    ['off', 'none'],
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
  ] as const)('Given thinkingLevel=%s When 注入 Then reasoning.effort=%s', (level, expectedEffort) => {
    const result = injectOpenAIThinkingLevel({ model: 'gpt-5.6-terra' }, level) as Record<string, unknown>
    expect(result.reasoning).toEqual({ effort: expectedEffort, summary: 'detailed' })
  })

  test('Given 推理关闭 + Codex 模型 Then 显式写入 none（GPT-5.x 默认 medium）', () => {
    const result = injectOpenAIThinkingLevel({ model: 'gpt-5.5' }, 'off') as Record<string, unknown>
    expect(result.reasoning).toEqual({ effort: 'none', summary: 'detailed' })
  })

  test('Given 非 Codex 模型 Then 不注入 reasoning', () => {
    const payload = { model: 'gpt-5.4-mini' }
    const result = injectOpenAIThinkingLevel(payload, 'high')
    expect(result).toBe(payload)
    expect((result as Record<string, unknown>).reasoning).toBeUndefined()
  })

  test('Given 已有 reasoning 字段 Then 仅更新 effort 保留其他字段', () => {
    const result = injectOpenAIThinkingLevel(
      { model: 'gpt-5.6-terra', reasoning: { mode: 'auto', summary: 'auto' } },
      'high',
    ) as Record<string, unknown>
    expect(result.reasoning).toEqual({ mode: 'auto', summary: 'detailed', effort: 'high' })
  })

  test('Given non-object payload Then 不注入', () => {
    expect(injectOpenAIThinkingLevel('not-a-request', 'high')).toBe('not-a-request')
  })
})

describe('Pi DeepSeek V4 Thinking Settings', () => {
  test.each(['deepseek-v4-pro', 'deepseek-v4-flash', 'gateway/deepseek-v4-pro'])(
    'Given %s + thinking enabled Then replaces budget thinking with max effort',
    (model) => {
      const result = injectDeepSeekV4ThinkingSettings({
        model,
        thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' },
      }, true) as Record<string, unknown>
      expect(result.thinking).toEqual({ type: 'enabled' })
      expect(result.output_config).toEqual({ effort: 'max' })
    },
  )

  test('Given enabled V4 request with output config Then preserves other output settings', () => {
    const result = injectDeepSeekV4ThinkingSettings({
      model: 'deepseek-v4-pro',
      output_config: { format: { type: 'text' }, effort: 'high' },
    }, true) as Record<string, unknown>
    expect(result.output_config).toEqual({ format: { type: 'text' }, effort: 'max' })
  })

  test('Given V4 thinking disabled Then explicitly disables without retaining budget', () => {
    const result = injectDeepSeekV4ThinkingSettings({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' },
    }, false) as Record<string, unknown>
    expect(result.thinking).toEqual({ type: 'disabled' })
  })

  test('Given old or unsupported DeepSeek model Then leaves payload unchanged', () => {
    const payload = { model: 'deepseek-reasoner', thinking: { type: 'enabled', budget_tokens: 1024 } }
    expect(injectDeepSeekV4ThinkingSettings(payload, true)).toBe(payload)
  })

  test('Given non-object payload Then leaves payload unchanged', () => {
    expect(injectDeepSeekV4ThinkingSettings('not-a-request', true)).toBe('not-a-request')
  })
})
