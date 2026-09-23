import { describe, expect, test } from 'bun:test'
import { normalizeChatStreamError } from './chat-error-utils'

describe('normalizeChatStreamError', () => {
  test('xAI 503 使用稳定的服务不可用提示，不泄露上游 JSON', () => {
    const result = normalizeChatStreamError(
      'xai',
      new Error('xai API 错误 (503): {"error":{"message":"Service temporarily unavailable","type":"server_error"}}'),
    )

    expect(result).toEqual({
      message: 'xAI 服务暂时不可用（503），系统已自动重试，请稍后再试。',
      code: 'upstream_unavailable',
      errorTitle: '服务暂时不可用',
    })
  })

  test('429 映射为限流提示', () => {
    expect(normalizeChatStreamError('openai', 'openai API 错误 (429): too many requests')).toEqual({
      message: '上游模型服务请求过于频繁（429），系统已自动重试，请稍后再试。',
      code: 'rate_limited',
      errorTitle: '请求过于频繁',
    })
  })

  test('非瞬时错误保留原始文案', () => {
    expect(normalizeChatStreamError('xai', new Error('xai API 错误 (401): invalid api key'))).toEqual({
      message: 'xai API 错误 (401): invalid api key',
    })
  })
})
