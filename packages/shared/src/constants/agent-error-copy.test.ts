import { describe, expect, test } from 'bun:test'
import { OPENAI_UPSTREAM_BUSY_MESSAGE, isOpenAIUpstreamBusyText } from './agent-error-copy'

describe('OpenAI 上游繁忙统一文案', () => {
  test('Given 用户文案 When 读取 Then 不含旧产品名与「您」', () => {
    expect(OPENAI_UPSTREAM_BUSY_MESSAGE).not.toContain('卡扣')
    expect(OPENAI_UPSTREAM_BUSY_MESSAGE).not.toContain('您的')
    expect(OPENAI_UPSTREAM_BUSY_MESSAGE).toContain('与你的账户无关')
  })

  test('Given 官方过载语义 When 识别 Then 命中统一文案', () => {
    expect(isOpenAIUpstreamBusyText('OpenAI 官方上游服务当前请求量较大，请稍后重试。')).toBe(true)
    expect(isOpenAIUpstreamBusyText('OpenAI API Error 529: overloaded')).toBe(true)
    expect(isOpenAIUpstreamBusyText('OpenAI rate limit reached')).toBe(true)
  })

  test('Given 无关错误或空值 When 识别 Then 不命中', () => {
    expect(isOpenAIUpstreamBusyText('Ollama tool-result stream error')).toBe(false)
    expect(isOpenAIUpstreamBusyText('invalid api key')).toBe(false)
    expect(isOpenAIUpstreamBusyText('')).toBe(false)
    expect(isOpenAIUpstreamBusyText(undefined)).toBe(false)
  })
})
