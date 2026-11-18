import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { markInsufficientCreditsMessage } from './agent-insufficient-credits'

function assistantError(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    error: { message: text },
  } as unknown as SDKMessage
}

/** 与商业版一致的判定：识别 402 与额度/余额文案。 */
const commercialDetector = (error: unknown) => {
  const text = typeof error === 'string'
    ? error
    : String((error as { message?: unknown })?.message ?? '')
  if (!/402/.test(text)) return null
  if (!/insufficient credit|额度不足|insufficient_credits|balance|billing/i.test(text)) return null
  return { message: '平台额度不足，请联系管理员充值' }
}

describe('新链额度不足结构化补齐', () => {
  test('Given 开源版 detector 恒为 null When 处理 402 消息 Then 不写任何字段', () => {
    const message = assistantError('API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.')
    const written = markInsufficientCreditsMessage(message, () => null)
    expect(written).toBe(false)
    const record = message as unknown as Record<string, unknown>
    expect(record._errorCode).toBeUndefined()
    expect(record._errorTitle).toBeUndefined()
    expect(record._errorActions).toBeUndefined()
  })

  test('Given 商业版 detector 命中代管 402 When 处理 Then 补齐额度卡片字段', () => {
    const message = assistantError('API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.')
    const written = markInsufficientCreditsMessage(message, commercialDetector)
    expect(written).toBe(true)
    const record = message as unknown as Record<string, unknown>
    expect(record._errorCode).toBe('insufficient_credits')
    expect(record._errorTitle).toBe('额度不足')
    expect(record._errorActions).toEqual([
      { key: 'c', label: '查看额度', action: 'open_credits' },
      { key: 'r', label: '重试', action: 'retry' },
    ])
  })

  test('Given 非额度错误 When 商业版 detector 处理 Then 保持原始消息', () => {
    const message = assistantError('API Error: 500 upstream unavailable')
    const written = markInsufficientCreditsMessage(message, commercialDetector)
    expect(written).toBe(false)
    expect((message as unknown as Record<string, unknown>)._errorCode).toBeUndefined()
  })

  test('Given 已有 _errorCode When 命中额度 Then 不覆盖既有结构化判定', () => {
    const message = assistantError('API Error: 402 Insufficient credit.')
    const record = message as unknown as Record<string, unknown>
    record._errorCode = 'provider_error'
    record._errorTitle = '上游错误'
    const written = markInsufficientCreditsMessage(message, commercialDetector)
    expect(written).toBe(false)
    expect(record._errorCode).toBe('provider_error')
    expect(record._errorTitle).toBe('上游错误')
    expect(record._errorActions).toBeUndefined()
  })

  test('Given 消息没有 error 字段 When 处理 Then 直接跳过', () => {
    const message = { type: 'assistant', message: { content: [] } } as unknown as SDKMessage
    expect(markInsufficientCreditsMessage(message, commercialDetector)).toBe(false)
  })

  test('Given 未提供 detector When 处理 Then 直接跳过（开源构建不注入）', () => {
    const message = assistantError('API Error: 402 Insufficient credit.')
    expect(markInsufficientCreditsMessage(message, undefined)).toBe(false)
  })
})
