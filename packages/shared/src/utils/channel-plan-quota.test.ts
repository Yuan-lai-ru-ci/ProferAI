import { describe, expect, test } from 'bun:test'
import { supportsProviderPlanQuota } from './channel-plan-quota'

describe('渠道订阅额度能力', () => {
  test('Given zhipu-coding When 判断 Then 支持 Coding Plan 额度', () => {
    expect(supportsProviderPlanQuota('zhipu-coding')).toBe(true)
  })

  test('Given 普通 zhipu When 判断 Then 不误认为 Coding Plan', () => {
    expect(supportsProviderPlanQuota('zhipu')).toBe(false)
  })
})
