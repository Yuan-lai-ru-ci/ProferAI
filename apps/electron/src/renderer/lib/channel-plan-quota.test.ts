import { describe, expect, test } from 'bun:test'
import { supportsChannelPlanQuota } from './channel-plan-quota'

describe('渲染层渠道订阅额度能力', () => {
  test('Given 普通 zhipu 渠道 When 判断 Then 不触发订阅额度查询', () => {
    expect(supportsChannelPlanQuota({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' })).toBe(false)
  })

  test('Given GLM Coding Plan 渠道 When 判断 Then 允许查询订阅额度', () => {
    expect(supportsChannelPlanQuota({ provider: 'zhipu-coding', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/' })).toBe(true)
  })

  test('Given Profer 代管的支持类型渠道 When 判断 Then 不查询第三方订阅额度', () => {
    expect(supportsChannelPlanQuota({
      provider: 'kimi-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      serverManaged: true,
    })).toBe(false)
  })
})
