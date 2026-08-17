import { describe, expect, test } from 'bun:test'
import { resolveReasoningProfile } from './reasoning-profile'

describe('GLM-5.3 reasoning profile', () => {
  test('Given the Zhipu OpenAI protocol When resolving GLM-5.3 Then exposes only off/high with the official toggle encoding', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })

    expect(profile?.id).toBe('glm-5.3')
    expect(profile?.levels).toEqual(['off', 'high'])
    expect(profile?.normalize('max')).toBe('high')
    expect(profile?.encodings['openai-completions']).toEqual({
      kind: 'zai-toggle',
      effortMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
    })
  })

  test('Given the Zhipu Coding Plan Anthropic protocol When resolving GLM-5.3 Then does not opt into adaptive effort', () => {
    expect(resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })?.encodings['anthropic-messages']?.kind)
      .toBe('anthropic-manual')
  })

  test('Given GLM-5.2 When resolving Then preserves its existing high/max effort semantics', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'openai-completions' })

    expect(profile?.levels).toEqual(['off', 'high', 'max'])
    expect(profile?.encodings['openai-completions']?.kind).toBe('zai-thinking-effort')
  })
})
