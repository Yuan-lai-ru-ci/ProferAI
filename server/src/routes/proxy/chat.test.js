import { describe, expect, test } from 'bun:test'
import { translateUpstreamError } from './upstream-error.js'

describe('代理上游计费错误分类', () => {
  test('供应商账户余额不足不应伪装为 Profer 用户积分不足', () => {
    const result = translateUpstreamError({
      error: { message: 'Insufficient account balance' },
    }, 403)

    expect(result.isQuota).toBe(false)
    expect(result.isUpstreamChannelBalance).toBe(true)
    expect(result.payload.code).toBe('upstream_channel_insufficient')
    expect(result.payload.error).toContain('模型供应通道')
  })

  test('New API 的预扣额度失败仍归类为平台额度不足', () => {
    const result = translateUpstreamError({
      error: { message: '预扣费额度失败, 用户剩余额度: ＄4.08' },
    }, 403)

    expect(result.isQuota).toBe(true)
    expect(result.isUpstreamChannelBalance).toBe(false)
    expect(result.payload.code).toBe('insufficient_credits')
  })
})
