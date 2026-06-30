/**
 * 计费工具测试
 *
 * 覆盖商业代理扣费最容易出错的纯逻辑：模型价格匹配、预估费用、实际 usage 结算。
 */
import { describe, expect, test } from 'bun:test'
import { calculateUsageCost, estimateProxyCost, findBillingRate } from './billing-utils.js'

describe('findBillingRate', () => {
  test('按最长模型名优先匹配价格', () => {
    const rate = findBillingRate('gpt-5-mini-2026-06-20', {
      'gpt-5': { input: 50, output: 150 },
      'gpt-5-mini': { input: 1, output: 2 },
    })

    expect(rate.input).toBe(1)
    expect(rate.output).toBe(2)
  })
})

describe('estimateProxyCost', () => {
  test('tiktoken 精确计数 + 3% 上浮（英文文本）', () => {
    // 4000 个 'x' → tiktoken cl100k_base 编码为 500 tokens
    // rawCost = 500/1000*1 + 1000/1000*2 = 2.5
    // safeCost = ceil(2.5 * 1.03) = ceil(2.575) = 3
    const cost = estimateProxyCost({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      max_tokens: 1000,
    }, {
      'gpt-5-mini': { input: 1, output: 2 },
    })

    expect(cost).toBe(3)
  })

  test('中文文本不会被低估（旧 /2 估算对中文严重偏低）', () => {
    // 600 个中文字 → tiktoken 编码约 540 tokens
    // 旧 /2 估算 = 300 tokens → 低估 ~44%
    // rawCost = 540/1000*1 + 400/1000*2 = 1.34
    // safeCost = ceil(1.34 * 1.03) = ceil(1.38) = 2
    const cost = estimateProxyCost({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: '你好世界这是一个测试中文文本'.repeat(50) }],
      max_tokens: 400,
    }, {
      'gpt-5-mini': { input: 1, output: 2 },
    })

    // 旧代码下会是 1（严重低估），新代码正确反映中文的高 token 消耗
    expect(cost).toBeGreaterThanOrEqual(2)
  })

  test('空请求也至少扣 1 credit，避免 0 费用绕过余额校验', () => {
    expect(estimateProxyCost({}, {})).toBeGreaterThanOrEqual(1)
  })
})

describe('calculateUsageCost', () => {
  test('缓存 token 超过 prompt token 时不会算出负输入费用', () => {
    const cost = calculateUsageCost({
      promptTokens: 100,
      completionTokens: 100,
      cacheCreationTokens: 80,
      cacheReadTokens: 80,
    }, {
      input: 10,
      output: 20,
      cacheReadRatio: 0.1,
    })

    // regular input 被钳制为 0，费用来自 cache creation、cache read 和 output。
    expect(cost).toBe(3)
  })
})
