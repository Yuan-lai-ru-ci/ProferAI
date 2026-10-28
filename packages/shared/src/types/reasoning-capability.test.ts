import { describe, expect, test } from 'bun:test'
import { resolveReasoningCapability, resolveReasoningProfile } from './reasoning-profile'

describe('resolveReasoningCapability', () => {
  test('Given profile 命中且 catalog 只有缺省映射 When 解析 Then 保留全部档位并透出实际编码', () => {
    const profile = resolveReasoningProfile({ modelId: 'deepseek-v4-pro', transport: 'anthropic-messages' })
    const capability = resolveReasoningCapability({
      profile,
      encoding: profile?.encodings['anthropic-messages'],
      // 跨 provider 兜底查到的目录条目常常没有 thinkingLevelMap；
      // 「缺省」不能被当成「不支持」，否则会把已验证的档位误删。
      catalog: { reasoning: true },
    })

    expect(capability?.source).toBe('profile')
    // DeepSeek Pro 官方只有 high / max：不再暴露会映射到同一个值的 low / xhigh。
    expect(capability?.levels).toEqual(['off', 'high', 'max'])
    expect(capability?.effortMap).toEqual({ high: 'high', max: 'max' })
  })

  test('Given DeepSeek Flash When 解析 Then 只保留能产生不同请求值的四档', () => {
    const profile = resolveReasoningProfile({ modelId: 'deepseek-flash', transport: 'anthropic-messages' })
    const capability = resolveReasoningCapability({
      profile,
      encoding: profile?.encodings['anthropic-messages'],
      catalog: { reasoning: true },
    })

    expect(capability?.levels).toEqual(['off', 'low', 'high', 'max'])
    expect(capability?.effortMap).toEqual({ low: 'low', high: 'high', max: 'max' })
  })

  test('Given catalog 显式把 xhigh 标为 null When 解析 Then 只剔除该档位', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-5.2', transport: 'openai-responses' })
    const capability = resolveReasoningCapability({
      profile,
      encoding: profile?.encodings['openai-responses'],
      catalog: { reasoning: true, thinkingLevelMap: { xhigh: null } },
    })

    expect(capability?.source).toBe('profile')
    expect(capability?.levels).toEqual(['off', 'low', 'medium', 'high'])
    expect(capability?.effortMap?.xhigh).toBeUndefined()
  })

  test('Given 默认档被 catalog 否决 When 解析 Then 默认档回退到仍可用的档位', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    const capability = resolveReasoningCapability({
      profile,
      encoding: profile?.encodings['openai-completions'],
      catalog: { reasoning: true, thinkingLevelMap: { high: null } },
    })

    expect(capability?.levels).toEqual(['low', 'max'])
    expect(capability?.defaultLevel).toBe('max')
  })

  test('Given catalog 明确 reasoning=false When 解析 Then 不暴露任何档位', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-5.2', transport: 'openai-responses' })
    const capability = resolveReasoningCapability({
      profile,
      encoding: profile?.encodings['openai-responses'],
      catalog: { reasoning: false },
    })

    expect(capability).toBeUndefined()
  })

  test('Given 没有 profile When 解析 catalog Then 档位与 effortMap 都来自 thinkingLevelMap', () => {
    const capability = resolveReasoningCapability({
      catalog: {
        reasoning: true,
        thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
      },
    })

    expect(capability?.source).toBe('pi-catalog')
    // Pi 的 extended 档位（xhigh/max）必须显式映射，其余档位缺省即可用。
    expect(capability?.levels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'max'])
    expect(capability?.effortMap).toEqual({ low: 'low', high: 'high', max: 'max' })
  })

  test('Given 既无 profile 也无 catalog When 解析 Then 返回 undefined 而不是猜测档位', () => {
    expect(resolveReasoningCapability({})).toBeUndefined()
  })
})
