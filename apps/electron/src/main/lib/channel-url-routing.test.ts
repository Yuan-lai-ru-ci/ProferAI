import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import { inferAgentBaseUrl, normalizeChannelForCurrentSchema } from './channel-url-routing'

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: 'ch_1',
    name: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: '',
    models: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('渠道 Chat/Agent URL 路由', () => {
  test('Given DeepSeek 旧 Anthropic Base URL When 迁移 Then Chat 与 Agent URL 被拆分', () => {
    const result = normalizeChannelForCurrentSchema(channel({}))

    expect(result.changed).toBe(true)
    expect(result.channel.baseUrl).toBe('https://api.deepseek.com')
    expect(result.channel.agentBaseUrl).toBe('https://api.deepseek.com/anthropic')
  })

  test('Given DeepSeek Chat Base URL When 推导 Agent URL Then 使用 Anthropic 兼容入口', () => {
    const agentUrl = inferAgentBaseUrl('deepseek', 'https://api.deepseek.com')

    expect(agentUrl).toBe('https://api.deepseek.com/anthropic')
  })

  test('Given DeepSeek OpenAI v1 Base URL When 迁移 Then 改为官方根地址', () => {
    const result = normalizeChannelForCurrentSchema(channel({
      baseUrl: 'https://api.deepseek.com/v1',
    }))

    expect(result.changed).toBe(true)
    expect(result.channel.baseUrl).toBe('https://api.deepseek.com')
    expect(result.channel.agentBaseUrl).toBe('https://api.deepseek.com/anthropic')
  })

  test('Given 自定义 Anthropic 兼容渠道 When 推导 Agent URL Then 复用用户填写的 Base URL', () => {
    const agentUrl = inferAgentBaseUrl('anthropic-compatible', 'https://gateway.example.com/anthropic/')

    expect(agentUrl).toBe('https://gateway.example.com/anthropic')
  })
})
