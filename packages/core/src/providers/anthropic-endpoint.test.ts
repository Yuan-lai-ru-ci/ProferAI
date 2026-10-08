import { expect, test } from 'bun:test'
import { AnthropicAdapter } from './anthropic-adapter'

test('Anthropic 流式与标题请求统一完整端点并保留 query/hash', () => {
  const adapter = new AnthropicAdapter('anthropic')
  const input = { baseUrl: 'https://fixture.invalid/v1/messages?route=fixture#anchor', apiKey: 'fixture-key', modelId: 'fixture-model' }
  const stream = adapter.buildStreamRequest({ ...input, userMessage: 'fixture', history: [], readImageAttachments: () => [] })
  const title = adapter.buildTitleRequest({ ...input, prompt: 'fixture' })
  expect(stream.url).toBe(input.baseUrl)
  expect(title.url).toBe(input.baseUrl)
  expect(stream.headers['x-api-key']).toBe(input.apiKey)
})

test('Anthropic 根地址只在 pathname 添加 messages，不插到 query 后', () => {
  const adapter = new AnthropicAdapter('anthropic')
  const title = adapter.buildTitleRequest({ baseUrl: 'https://fixture.invalid?route=fixture', apiKey: 'fixture-key', modelId: 'fixture-model', prompt: 'fixture' })
  expect(title.url).toBe('https://fixture.invalid/v1/messages?route=fixture')
})
