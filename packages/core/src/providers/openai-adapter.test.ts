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

  test('通过 OpenAI 兼容渠道接入的 DeepSeek V4 标题请求也显式关闭推理', () => {
    const request = new OpenAIAdapter('openai').buildTitleRequest({
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'key',
      modelId: 'deepseek-v4.1-flash',
      prompt: 'title',
    })
    expect(JSON.parse(request.body)).toMatchObject({
      max_tokens: 128,
      thinking: { type: 'disabled' },
    })
  })

  test('GPT-6 系列标题请求降到最低可用档位而不是 none', () => {
    const request = new OpenAIAdapter('custom').buildTitleRequest({
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'key',
      modelId: 'gpt-6.1-sol',
      prompt: 'title',
    })
    // GPT-6 代际已取消 none / minimal：发 none 会被服务端拒绝，最低档是 low。
    expect(JSON.parse(request.body)).toMatchObject({ reasoning_effort: 'low' })
  })
})

describe('OpenAIAdapter 流式 content 内容块', () => {
  test('Given 内容块数组 When 解析 Then 正文与思考分开且不出现 [object Object]', () => {
    const adapter = new OpenAIAdapter('custom')
    const chunk = (delta: unknown): string => JSON.stringify({ choices: [{ index: 0, delta }] })

    expect(adapter.parseSSELine(chunk({ content: [{ type: 'text', text: '你好' }] }))).toEqual([
      { type: 'chunk', delta: '你好' },
    ])
    expect(adapter.parseSSELine(chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: '想一想' }] }] }))).toEqual([
      { type: 'reasoning', delta: '想一想' },
    ])
    // 字符串增量保持原行为
    expect(adapter.parseSSELine(chunk({ content: 'hi' }))).toEqual([{ type: 'chunk', delta: 'hi' }])
    expect(adapter.parseSSELine(chunk({ content: '' }))).toEqual([])
  })
})
