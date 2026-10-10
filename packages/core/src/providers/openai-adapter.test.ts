import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter.ts'

describe('OpenAIAdapter Ollama Chat', () => {
  test('根地址使用 Ollama OpenAI-compatible chat endpoint', () => {
    const request = new OpenAIAdapter('ollama').buildStreamRequest({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelId: 'qwen3:8b',
      history: [],
      userMessage: '你好',
      readImageAttachments: () => [],
    })

    expect(request.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(request.headers.Authorization).toBe('Bearer ollama')
    expect(JSON.parse(request.body)).toMatchObject({ model: 'qwen3:8b', stream: true })
  })

  test('/v1 地址不会重复拼接，显式 key 会被保留', () => {
    const request = new OpenAIAdapter('ollama').buildTitleRequest({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'local-key',
      modelId: 'llama3.2',
      prompt: 'title',
    })

    expect(request.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(request.headers.Authorization).toBe('Bearer local-key')
    expect(JSON.parse(request.body)).toMatchObject({ max_tokens: 128 })
  })

  test('reasoning 模型标题请求显式关闭推理', () => {
    const request = new OpenAIAdapter('deepseek').buildTitleRequest({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'key',
      modelId: 'deepseek-flash',
      prompt: 'title',
    })
    expect(JSON.parse(request.body)).toMatchObject({
      max_tokens: 128,
      thinking: { type: 'disabled' },
    })
  })

  test('GPT-6 系列标题请求显式关闭 reasoning', () => {
    const request = new OpenAIAdapter('custom').buildTitleRequest({
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'key',
      modelId: 'gpt-6.1-sol',
      prompt: 'title',
    })
    expect(JSON.parse(request.body)).toMatchObject({ reasoning_effort: 'none' })
  })
})
