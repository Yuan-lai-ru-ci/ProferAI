import { test, expect, describe } from 'bun:test'
import { detectInsufficientCredits } from './insufficient-credits.ts'

describe('detectInsufficientCredits', () => {
  // sse-reader 实际抛出的格式：`<provider> API 错误 (402)，请求端点：<url>: <body>`
  const realError =
    'anthropic API 错误 (402)，请求端点：https://x/v1/proxy/messages: {"error":"额度不足","message":"当前余额 30 credits，本次预估消耗 120 credits","balance":30,"required":120}'

  test('识别真实 402 错误并解析余额/所需额度', () => {
    const info = detectInsufficientCredits(realError)
    expect(info).not.toBeNull()
    expect(info?.balance).toBe(30)
    expect(info?.required).toBe(120)
    expect(info?.message).toContain('当前余额 30 credits')
  })

  test('接受 Error 实例', () => {
    const info = detectInsufficientCredits(new Error(realError))
    expect(info?.balance).toBe(30)
  })

  test('显式传入 status=402 时即使无嵌入 JSON 也识别', () => {
    const info = detectInsufficientCredits('账户额度不足', 402)
    expect(info).not.toBeNull()
    expect(info?.message).toBe('账户额度不足，请联系管理员充值')
  })

  test('带 status 字段的对象', () => {
    const info = detectInsufficientCredits({ message: '额度不足', status: 402 })
    expect(info).not.toBeNull()
  })

  test('文本含「额度不足」字样且无矛盾状态码时兜底识别', () => {
    const info = detectInsufficientCredits('Error: 额度不足，请充值')
    expect(info).not.toBeNull()
  })

  test('非 402 错误（429 限流）不误判', () => {
    expect(detectInsufficientCredits('API 错误 (429)，请求过于频繁')).toBeNull()
  })

  test('500 错误不误判', () => {
    expect(detectInsufficientCredits('API 错误 (500): internal error')).toBeNull()
  })

  test('普通网络错误不误判', () => {
    expect(detectInsufficientCredits('fetch failed: ECONNRESET')).toBeNull()
  })

  test('显式 status 非 402 时即使文本含额度字样也不误判', () => {
    expect(detectInsufficientCredits('额度不足', 500)).toBeNull()
  })

  test('空输入安全返回 null', () => {
    expect(detectInsufficientCredits('')).toBeNull()
    expect(detectInsufficientCredits(null)).toBeNull()
    expect(detectInsufficientCredits(undefined)).toBeNull()
  })

  test('New API 上游 403 预扣费额度失败（含美元文案）识别为额度不足', () => {
    const text = 'Failed to authenticate. API Error: 403 {"error":"预扣费额度失败, 用户剩余额度: ＄4.08, 需要预扣费额度: ＄5.93"}'
    const info = detectInsufficientCredits(text, 403)
    expect(info).not.toBeNull()
    expect(info?.message).toContain('额度')
  })

  test('403 但无额度文本特征（纯认证失败）不误判为额度不足', () => {
    expect(detectInsufficientCredits('API Error: 403 invalid api key', 403)).toBeNull()
  })

  test('server 翻译后的 平台额度暂时不足 也能识别', () => {
    const info = detectInsufficientCredits('{"error":"平台额度暂时不足，请联系管理员充值","code":"insufficient_credits"}', 403)
    expect(info).not.toBeNull()
  })

  test('402 但 body 无 balance 字段时 balance 为 undefined，message 用兜底', () => {
    const info = detectInsufficientCredits('API 错误 (402): {"error":"额度不足"}')
    expect(info).not.toBeNull()
    expect(info?.balance).toBeUndefined()
    expect(info?.message).toBe('账户额度不足，请联系管理员充值')
  })
})
