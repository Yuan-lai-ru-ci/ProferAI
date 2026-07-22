import { describe, expect, test } from 'bun:test'
import { createPricingContext, assertVipPricingReady } from './pricing-context.js'

const catalog = { 'claude-sonnet': 0.6, 'gpt-5': 0.5 }
const vipConfig = { modelDiscount: 0.8, newApiGroup: 'vip' }

describe('VIP model pricing context', () => {
  test('ordinary users retain base model multipliers in the default group', () => {
    expect(createPricingContext({ is_vip: 0 }, 'claude-sonnet', { modelMultipliers: catalog, vipConfig }))
      .toMatchObject({ audience: 'default', newApiGroup: 'default', modelMultiplier: 0.6, groupMultiplier: 1, effectiveMultiplier: 0.6 })
  })

  test('VIP users get the configured New API group and exactly one discount', () => {
    expect(createPricingContext({ is_vip: 1 }, 'gpt-5', { modelMultipliers: catalog, vipConfig }))
      .toMatchObject({ audience: 'vip', newApiGroup: 'vip', modelMultiplier: 0.5, groupMultiplier: 0.8, effectiveMultiplier: 0.4 })
  })

  test('VIP requests fail closed without a configured model price or personal New API key', () => {
    const missingModel = createPricingContext({ is_vip: 1 }, 'unknown', { modelMultipliers: catalog, vipConfig })
    expect(() => assertVipPricingReady(missingModel, { perUserNewApiKey: true, hasNewApiKey: true })).toThrow('VIP_MODEL_PRICE_MISSING')
    const valid = createPricingContext({ is_vip: 1 }, 'claude-sonnet', { modelMultipliers: catalog, vipConfig })
    expect(() => assertVipPricingReady(valid, { perUserNewApiKey: false, hasNewApiKey: true })).toThrow('VIP_PRICING_REQUIRES_PER_USER_NEWAPI_KEY')
  })
})
