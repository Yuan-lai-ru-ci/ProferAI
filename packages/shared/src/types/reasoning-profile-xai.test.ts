import { describe, expect, test } from 'bun:test'
import { inferReasoningTransport, resolveReasoningProfile } from './reasoning-profile'

describe('xAI Grok reasoning profile', () => {
  test('Given grok-4.6 When resolving Responses profile Then exposes xAI supported effort levels', () => {
    const profile = resolveReasoningProfile({ modelId: 'grok-4.6', transport: 'openai-responses' })

    expect(inferReasoningTransport('xai')).toBe('openai-responses')
    expect(profile?.id).toBe('grok-4.6')
    // xAI 当前模型「始终推理」：没有关闭档，官方只列 low/medium/high/xhigh（无 max）。
    expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(profile?.encodings['openai-responses']?.effortMap).toMatchObject({
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'xhigh',
    })
  })
})
