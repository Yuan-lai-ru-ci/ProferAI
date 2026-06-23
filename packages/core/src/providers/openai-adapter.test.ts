/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter'

describe('OpenAI 兼容适配器', () => {
  test('Given DeepSeek provider When 构建 Chat 请求 Then 使用 OpenAI Chat Completions 端点', () => {
    const adapter = new OpenAIAdapter('deepseek')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-pro',
      history: [],
      userMessage: 'hi',
      readImageAttachments: () => [],
    })

    expect(request.url).toBe('https://api.deepseek.com/chat/completions')
  })

  test('Given DeepSeek thinking enabled When 构建 Chat 请求 Then 注入 DeepSeek OpenAI 格式思考参数', () => {
    const adapter = new OpenAIAdapter('deepseek')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-pro',
      history: [],
      userMessage: 'hi',
      readImageAttachments: () => [],
      thinkingEnabled: true,
    })
    const body = JSON.parse(request.body) as { thinking?: { type?: string }; reasoning_effort?: string }

    expect(request.url).toBe('https://api.deepseek.com/chat/completions')
    expect(body.thinking?.type).toBe('enabled')
    expect(body.reasoning_effort).toBe('high')
  })

  test('Given DeepSeek thinking disabled When 构建 Chat 请求 Then 显式关闭思考', () => {
    const adapter = new OpenAIAdapter('deepseek')
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-flash',
      history: [],
      userMessage: 'hi',
      readImageAttachments: () => [],
    })
    const body = JSON.parse(request.body) as { thinking?: { type?: string }; reasoning_effort?: string }

    expect(body.thinking?.type).toBe('disabled')
    expect(body.reasoning_effort).toBeUndefined()
  })
})
