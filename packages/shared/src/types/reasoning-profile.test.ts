import { describe, expect, test } from 'bun:test'
import type { AgentThinkingLevel } from './agent'
import { isClaudeAdaptiveThinkingModel, resolveReasoningModelTag, resolveReasoningProfile } from './reasoning-profile'

describe('OpenAI reasoning profile', () => {
  test('Given GPT-6 Astra When resolving Then exposes five effort levels without off/minimal', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })

    expect(profile?.id).toBe('openai-reasoning-gpt6')
    expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(profile?.encodings['openai-responses']?.effortMap.off).toBeNull()
    expect(profile?.encodings['openai-responses']?.effortMap.minimal).toBe('low')
  })

  test('Given GPT-6.1 Sol When resolving Then inherits the same GPT-6 effort levels as Astra', () => {
    const sol = resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'openai-responses' })
    const astra = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })

    expect(sol).toEqual(astra)
    expect(sol?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // 官方文档：none 与 minimal 均不支持，最低档是 low。
    expect(sol?.encodings['openai-responses']?.effortMap.off).toBeNull()
    expect(resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'openai-completions' })?.id)
      .toBe('openai-reasoning-gpt6')
  })

  test('Given GPT-5.6 When resolving Then adds max; GPT-5.5 stays on the standard profile', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-5.6-sol', transport: 'openai-responses' })?.id)
      .toBe('openai-reasoning-max')
    expect(resolveReasoningProfile({ modelId: 'gpt-5.5', transport: 'openai-responses' })?.levels)
      .toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(resolveReasoningProfile({ modelId: 'o3-mini', transport: 'openai-responses' })?.id)
      .toBe('openai-reasoning-standard')
  })

  test('Given non-reasoning or prefixed IDs When resolving Then only real families match', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-5-chat-latest', transport: 'openai-responses' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'gpt-4o', transport: 'openai-responses' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'openai/gpt-6.1-sol', transport: 'openai-responses' })?.id)
      .toBe('openai-reasoning-gpt6')
  })
})

describe('Kimi reasoning profiles', () => {
  test('Given Kimi K3 When resolving Then only low/high/max are offered (thinking always on)', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k3', transport: 'openai-completions' })

    expect(profile?.id).toBe('kimi-k3')
    expect(profile?.levels).toEqual(['low', 'high', 'max'])
    expect(profile?.normalize('off')).toBe('low')
    expect(profile?.encodings['openai-completions']?.effortMap).toMatchObject({
      low: 'low',
      medium: 'high',
      high: 'high',
      max: 'max',
    })
  })

  test('Given Kimi K3.1 Pro When resolving Then inherits the K3 effort protocol', () => {
    for (const modelId of ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding']) {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })?.id).toBe('kimi-k3')
      expect(resolveReasoningProfile({ modelId, transport: 'anthropic-messages' })?.id).toBe('kimi-k3')
    }
  })

  test('Given K2.6 When resolving Then only off/high exist and the toggle keeps catalog compat', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k2.6', transport: 'openai-completions' })

    expect(profile?.id).toBe('kimi-k2.6-toggle')
    expect(profile?.levels).toEqual(['off', 'high'])
    // off 不写进 effortMap：Pi 依据 `off !== null` 才会真的发 thinking.type=disabled。
    expect(profile?.encodings['openai-completions']?.effortMap.off).toBeUndefined()
  })

  test('Given K2.7 Code When resolving Then thinking cannot be turned off', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k2.7-code', transport: 'openai-completions' })

    expect(profile?.id).toBe('kimi-k2.7-always-on')
    expect(profile?.levels).toEqual(['high'])
    expect(profile?.normalize('off')).toBe('high')
  })
})

describe('GLM reasoning profile', () => {
  test('Given GLM-5.3 When resolving Then exposes the official low/high/max effort levels', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })

    expect(profile?.id).toBe('glm-5.3')
    expect(profile?.levels).toEqual(['low', 'high', 'max'])
    expect(profile?.normalize('max')).toBe('max')
    expect(profile?.encodings['openai-completions']).toEqual({
      kind: 'zai-thinking-effort',
      effortMap: {
        off: null,
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'max',
        max: 'max',
      },
    })
  })

  test('Given GLM-5.3 variants When resolving Then they inherit the same effort levels', () => {
    for (const modelId of ['glm-5.3-flash', 'glm-5.3-highspeed', 'glm-5.3-flashx']) {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })?.id).toBe('glm-5.3')
    }
  })

  test('Given the Zhipu Coding Plan Anthropic protocol When resolving GLM-5.3 Then does not opt into adaptive effort', () => {
    expect(resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })?.encodings['anthropic-messages']?.kind)
      .toBe('anthropic-manual')
  })

  test('Given GLM-5.2 When resolving Then preserves its existing high/max effort semantics', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'openai-completions' })

    expect(profile?.levels).toEqual(['off', 'high', 'max'])
    expect(profile?.encodings['openai-completions']?.kind).toBe('zai-thinking-effort')
    expect(resolveReasoningProfile({ modelId: 'glm-5.2-highspeed', transport: 'openai-completions' })?.id)
      .toBe('glm-5.2')
  })
})

describe('Grok / Qwen / MiMo reasoning profiles', () => {
  test('Given Grok 4.6+ When resolving Then thinking cannot be disabled and xhigh is available', () => {
    for (const modelId of ['grok-4.6', 'grok-4.7']) {
      const profile = resolveReasoningProfile({ modelId, transport: 'openai-responses' })
      expect(profile?.id).toBe('grok-4.6')
      expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh'])
    }
    expect(resolveReasoningProfile({ modelId: 'grok-4.5', transport: 'openai-responses' })?.levels)
      .toEqual(['low', 'medium', 'high'])
    expect(resolveReasoningProfile({ modelId: 'grok-4.3', transport: 'openai-responses' })?.levels)
      .toEqual(['off', 'low', 'medium', 'high'])
  })

  test('Given Qwen3.8 When resolving Then maps product high onto the official xhigh tier', () => {
    const profile = resolveReasoningProfile({ modelId: 'qwen3.8-max', transport: 'openai-completions' })

    expect(profile?.id).toBe('qwen-3.8')
    expect(profile?.levels).toEqual(['low', 'medium', 'high'])
    expect(profile?.encodings['openai-completions']?.kind).toBe('qwen-thinking-effort')
    expect(profile?.encodings['openai-completions']?.effortMap.high).toBe('xhigh')
    expect(resolveReasoningProfile({ modelId: 'qwen3.7-max', transport: 'openai-completions' })?.id)
      .toBe('qwen-toggle')
  })

  test('Given MiMo V2.5 When resolving Then only a thinking toggle is exposed', () => {
    const profile = resolveReasoningProfile({ modelId: 'mimo-v2.5-pro', transport: 'openai-completions' })

    expect(profile?.id).toBe('mimo-toggle')
    expect(profile?.levels).toEqual(['off', 'high'])
  })
})

describe('DeepSeek reasoning profile', () => {
  test('Given DeepSeek Flash / Pro When resolving Then 只暴露官方 effort 能区分的档位', () => {
    const flash = resolveReasoningProfile({ modelId: 'deepseek-flash', transport: 'anthropic-messages' })
    const pro = resolveReasoningProfile({ modelId: 'deepseek-v4-pro', transport: 'anthropic-messages' })

    expect(flash?.levels).toEqual(['off', 'low', 'high', 'max'])
    expect(pro?.levels).toEqual(['off', 'high', 'max'])
    // 每个产品档位都必须产生不同的请求值，否则界面上会出现「选不同档、发同一个值」。
    const distinct = (levels: readonly AgentThinkingLevel[], map: Record<string, string | null | undefined>) =>
      new Set(levels.filter((level) => level !== 'off').map((level) => map[level])).size
    expect(distinct(flash!.levels, flash!.encodings['anthropic-messages']!.effortMap)).toBe(3)
    expect(distinct(pro!.levels, pro!.encodings['anthropic-messages']!.effortMap)).toBe(2)
  })

  test('Given DeepSeek 官方短名 When resolving Then 与同代正式 ID 得到同一档位协议', () => {
    const flashAlias = resolveReasoningProfile({ modelId: 'deepseek-flash', transport: 'anthropic-messages' })
    const flashOfficial = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    const proAlias = resolveReasoningProfile({ modelId: 'deepseek-pro', transport: 'anthropic-messages' })

    expect(flashAlias?.id).toBe('deepseek-v4-flash')
    expect(flashAlias?.encodings['anthropic-messages']?.kind).toBe('deepseek-output-effort')
    expect(flashAlias).toEqual(flashOfficial)
    expect(proAlias?.id).toBe('deepseek-v4-pro')
  })

  test('Given DeepSeek 旧世代模型 When resolving Then 短名别名不误扩档位', () => {
    expect(resolveReasoningProfile({ modelId: 'deepseek-chat', transport: 'anthropic-messages' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'deepseek-reasoner', transport: 'anthropic-messages' })).toBeUndefined()
  })
})

describe('Claude adaptive thinking profile', () => {
  test('Given claude-haiku-5-5 When resolving on Anthropic transport Then uses adaptive effort and omits thinking when off', () => {
    const profile = resolveReasoningProfile({ modelId: 'claude-haiku-5-5', transport: 'anthropic-messages' })

    expect(profile?.id).toBe('claude-adaptive')
    expect(profile?.encodings['anthropic-messages']?.kind).toBe('adaptive-effort')
    expect(profile?.encodings['anthropic-messages']?.effortMap).toMatchObject({
      off: null,
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'max',
      max: 'max',
    })
  })

  test('Given Claude 5.x families and Opus 4.7/4.8 When checking adaptive support Then only those generations match', () => {
    for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-mythos-preview']) {
      expect(isClaudeAdaptiveThinkingModel(modelId)).toBe(true)
    }
    for (const modelId of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-3-7-sonnet', 'claude-3-5-sonnet']) {
      expect(isClaudeAdaptiveThinkingModel(modelId)).toBe(false)
    }
  })

  test('Given a provider-prefixed Claude 5.x ID When checking adaptive support Then still matches the model family', () => {
    expect(isClaudeAdaptiveThinkingModel('anthropic/claude-haiku-5-5')).toBe(true)
    expect(resolveReasoningProfile({ modelId: 'anthropic/claude-haiku-5-5', transport: 'anthropic-messages' })?.id)
      .toBe('claude-adaptive')
  })

  test('Given older Claude When resolving Then it keeps the manual protocol instead of claiming adaptive', () => {
    expect(resolveReasoningProfile({ modelId: 'claude-haiku-4-5', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test('Given a Claude model on an OpenAI transport When resolving Then no Anthropic encoding is exposed', () => {
    expect(resolveReasoningProfile({ modelId: 'claude-opus-5', transport: 'openai-completions' })).toBeUndefined()
  })
})

describe('模型能力家族 tag', () => {
  test('Given 已覆盖的型号 When 解析 tag Then 同族新版本自动继承', () => {
    expect(resolveReasoningModelTag('gpt-6.1-sol')).toBe('openai-gpt-6')
    expect(resolveReasoningModelTag('gpt-6-astra')).toBe('openai-gpt-6')
    expect(resolveReasoningModelTag('gpt-5.6-sol')).toBe('openai-gpt-5-max')
    expect(resolveReasoningModelTag('gpt-5.4-mini')).toBe('openai-gpt-5-standard')
    expect(resolveReasoningModelTag('kimi-k3.1-pro')).toBe('kimi-k3')
    expect(resolveReasoningModelTag('glm-5.3-flash')).toBe('glm-5.3')
    expect(resolveReasoningModelTag('grok-4.7')).toBe('grok-4.6')
    expect(resolveReasoningModelTag('deepseek-v4-flash')).toBe('deepseek-v4-flash')
  })

  test('Given 非推理或未覆盖型号 When 解析 tag Then 返回 undefined 交给 catalog', () => {
    expect(resolveReasoningModelTag('gpt-5-chat-latest')).toBeUndefined()
    expect(resolveReasoningModelTag('glm-4.7')).toBe('glm-legacy-toggle')
    expect(resolveReasoningModelTag('glm-x-preview')).toBeUndefined()
    expect(resolveReasoningModelTag('qwen-max')).toBeUndefined()
    expect(resolveReasoningModelTag(undefined)).toBeUndefined()
  })
})
