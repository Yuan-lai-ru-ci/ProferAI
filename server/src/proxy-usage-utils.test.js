/**
 * 代理用量解析测试
 */
import { describe, expect, test } from 'bun:test'
import { createStreamUsageTracker, extractUsage, withOpenAIStreamUsage } from './proxy-usage-utils.js'

describe('proxy usage utils', () => {
  test('OpenAI 流式请求自动开启 include_usage', () => {
    const body = withOpenAIStreamUsage({
      model: 'gpt-5-mini',
      stream: true,
      stream_options: { foo: 'bar' },
    }, '/v1/chat/completions')

    expect(body.stream_options).toEqual({ foo: 'bar', include_usage: true })
  })

  test('Anthropic usage 会把缓存 token 计入 prompt 和 total', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 50,
      },
    })

    expect(usage).toEqual({
      promptTokens: 170,
      completionTokens: 30,
      totalTokens: 200,
      cacheCreationTokens: 20,
      cacheReadTokens: 50,
    })
  })

  test('解析 OpenAI 流式最后 usage 块', () => {
    const tracker = createStreamUsageTracker('gpt-5-mini')
    tracker.ingest('data: {"id":"1","model":"gpt-5-mini","choices":[{"delta":{"content":"hi"}}]}\n\n')
    tracker.ingest('data: {"id":"1","model":"gpt-5-mini","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20,"prompt_tokens_details":{"cached_tokens":5}}}\n\n')
    tracker.ingest('data: [DONE]\n\n')

    const result = tracker.finish()
    expect(result.model).toBe('gpt-5-mini')
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 5,
    })
  })

  test('解析 Anthropic 流式 message_delta usage', () => {
    const tracker = createStreamUsageTracker('claude-sonnet-4-5')
    tracker.ingest('data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_read_input_tokens":40}}}\n')
    tracker.ingest('data: {"type":"message_delta","usage":{"output_tokens":25}}\n')

    const result = tracker.finish()
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(result.usage).toEqual({
      promptTokens: 50,
      completionTokens: 25,
      totalTokens: 75,
      cacheCreationTokens: 0,
      cacheReadTokens: 40,
    })
  })
})
