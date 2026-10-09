import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
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

  test('Given DeepSeek 渠道指向第三方网关 When 迁移 Then 不得被官方默认值覆盖', () => {
    const result = normalizeChannelForCurrentSchema(channel({
      baseUrl: 'https://gateway.example.com/anthropic',
    }))

    expect(result.channel.baseUrl).toBe('https://gateway.example.com/anthropic')
    expect(result.channel.agentBaseUrl).toBe('https://gateway.example.com/anthropic')
  })

  test('Given DeepSeek 的 Base URL 已切到第三方网关 When 仍留有官方 Agent URL Then Agent 跟随新地址', () => {
    // 历史配置把官方默认值持久化进 agentBaseUrl；用户改 Base URL 后它不能继续生效，
    // 否则 Chat 打网关、Agent 打官方，表现为「换了 URL 依旧请求不到」。
    const agentUrl = inferAgentBaseUrl(
      'deepseek',
      'https://gateway.example.com/v1',
      'https://api.deepseek.com/anthropic',
    )

    expect(agentUrl).toBe('https://gateway.example.com/v1')
  })

  test('Given DeepSeek 渠道显式配置非官方 Agent 入口 When 推导 Then 尊重显式值', () => {
    const agentUrl = inferAgentBaseUrl(
      'deepseek',
      'https://gateway.example.com/v1',
      'https://gateway.example.com/anthropic',
    )

    expect(agentUrl).toBe('https://gateway.example.com/anthropic')
  })

  test('Given 官方 DeepSeek Base URL When 推导 Then 仍使用官方 Anthropic 入口', () => {
    expect(inferAgentBaseUrl('deepseek', 'https://api.deepseek.com')).toBe('https://api.deepseek.com/anthropic')
    expect(inferAgentBaseUrl('deepseek', 'https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/anthropic')
    expect(inferAgentBaseUrl('deepseek', '')).toBe('https://api.deepseek.com/anthropic')
  })

  test('Given 自定义 Anthropic 兼容渠道 When 推导 Agent URL Then 复用用户填写的 Base URL', () => {
    const agentUrl = inferAgentBaseUrl('anthropic-compatible', 'https://gateway.example.com/anthropic/')

    expect(agentUrl).toBe('https://gateway.example.com/anthropic')
  })

  test('Given Anthropic 渠道指向自建网关 When 推导 Agent URL Then 优先用户 Base URL 而非官方默认', () => {
    // 回归：此前直接返回 PROVIDER_DEFAULT_AGENT_URLS.anthropic，Pi-only 的自建
    // Anthropic 网关渠道会被静默打到 api.anthropic.com。
    expect(inferAgentBaseUrl('anthropic', 'https://cn.clawnode.cn')).toBe('https://cn.clawnode.cn')
    // 用户填的就是官方地址时，仍返回官方默认（行为不变）。
    expect(inferAgentBaseUrl('anthropic', 'https://api.anthropic.com')).toBe('https://api.anthropic.com')
    expect(inferAgentBaseUrl('anthropic', '')).toBe('https://api.anthropic.com')
  })

  test('Given OpenAI 渠道没有单独 Agent URL When Pi runtime 请求 Then 复用用户配置的 OpenAI Base URL', () => {
    const agentUrl = inferAgentBaseUrl('openai', 'https://cn.clawnode.cn/v1')

    expect(agentUrl).toBe('https://cn.clawnode.cn/v1')
  })

  test('Given xAI 渠道没有单独 Agent URL When Pi runtime 请求 Then 复用 xAI Responses Base URL', () => {
    expect(inferAgentBaseUrl('xai', 'https://api.x.ai/v1')).toBe('https://api.x.ai/v1')
  })

  test('Given Ollama Chat Base URL When 推导 Agent URL Then 使用服务根地址', () => {
    expect(inferAgentBaseUrl('ollama', 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
    expect(inferAgentBaseUrl('ollama', 'http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434')
  })

  test.each([
    ['openai', 'https://gateway.example.com/v1'],
    ['openai-responses', 'https://gateway.example.com/v1/responses'],
    ['opencode-go-openai', 'https://gateway.example.com/v1'],
    ['zhipu', 'https://gateway.example.com/api/paas/v4'],
    ['doubao', 'https://gateway.example.com/api/v3'],
    ['qwen', 'https://gateway.example.com/compatible-mode/v1'],
    ['google', 'https://generativelanguage.googleapis.com'],
    ['custom', 'https://gateway.example.com/v1/chat/completions'],
  ] as const)('Given %s Pi 原生渠道 When 推导 Agent URL Then 复用用户填写的 Base URL', (provider, baseUrl) => {
    expect(inferAgentBaseUrl(provider, baseUrl)).toBe(baseUrl)
  })
})
