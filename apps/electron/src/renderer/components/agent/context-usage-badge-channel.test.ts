import { describe, expect, test } from 'bun:test'
import { resolvePlanQuotaChannelId } from './context-usage-badge-channel'

describe('Agent 上下文额度渠道选择', () => {
  test('Given 当前会话渠道 When 解析 Then 优先使用当前渠道', () => {
    expect(resolvePlanQuotaChannelId('session-channel', 'previous-channel')).toBe('session-channel')
  })

  test('Given 初始化短暂缺少当前渠道 When 解析 Then 保留最近稳定渠道', () => {
    expect(resolvePlanQuotaChannelId(undefined, 'previous-channel')).toBe('previous-channel')
  })

  test('Given 从未有有效渠道 When 解析 Then 不触发额度查询', () => {
    expect(resolvePlanQuotaChannelId(undefined, undefined)).toBeUndefined()
  })
})
