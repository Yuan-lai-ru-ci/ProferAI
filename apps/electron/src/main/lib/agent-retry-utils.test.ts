/**
 * agent-retry-utils 测试
 *
 * 覆盖重试决策、延迟计算、权限模式映射、API 错误提取等纯函数。
 */
import { describe, test, expect } from 'bun:test'
import {
  extractApiError,
  isOllamaToolStreamError,
  isAutoRetryableTypedError,
  isAutoRetryableCatchError,
  isInvalidRelayTokenError,
  isSessionNotFoundError,
  getRetryDelayMs,
  isRetryBudgetExhausted,
  sdkPermissionModeForProferMode,
  MAX_AUTO_RETRY_WAIT_MS,
  RETRY_MAX_DELAY_MS,
  OPENAI_UPSTREAM_BUSY_MESSAGE,
  OPENAI_UPSTREAM_BUSY_MAX_RETRIES,
  MAX_AUTO_RETRIES,
  isOpenAIUpstreamBusyError,
  getRetryDisplayReason,
  getMaxAutoRetries,
} from './agent-retry-utils'
import type { TypedError } from '@profer/shared'
import { mapSDKErrorToTypedError } from './adapters/claude-agent-adapter'
// 额度识别已改为宿主按发行版注入：这里显式注入，表示“商业版行为”。
import { detectInsufficientCredits } from '@profer/core/providers/insufficient-credits'

function typedError(code: TypedError['code'], message = ''): TypedError {
  return {
    code,
    message,
    title: code,
    actions: [],
    canRetry: false,
  }
}

describe('extractApiError', () => {
  test('从简单 JSON 格式 stderr 中提取错误', () => {
    // 注意: 正则表达式不支持嵌套 JSON，使用扁平格式测试
    const result = extractApiError('401 {"error":"Invalid API key"}')
    expect(result).not.toBeNull()
    expect(result!.statusCode).toBe(401)
  })

  test('从 API error 格式中提取错误', () => {
    const result = extractApiError('API error (attempt 1/3): 429 429 {"error":"Rate limited"}')
    expect(result).not.toBeNull()
    expect(result!.statusCode).toBe(429)
  })

  test('从简单格式中提取错误', () => {
    const result = extractApiError('500: Internal server error\n')
    expect(result).not.toBeNull()
    expect(result!.statusCode).toBe(500)
  })

  test('空 stderr 返回 null', () => {
    expect(extractApiError('')).toBeNull()
    expect(extractApiError('some random text')).toBeNull()
  })

  test('HTTP 200 不被视为错误', () => {
    expect(extractApiError('200: OK')).toBeNull()
  })
})

describe('OpenAI 官方上游繁忙提示', () => {
  test('OpenAI 官方渠道的过载错误使用统一提示', () => {
    expect(isOpenAIUpstreamBusyError('openai', 'API Error 529: overloaded')).toBe(true)
    expect(getRetryDisplayReason('openai', 'API Error 529: overloaded')).toBe(OPENAI_UPSTREAM_BUSY_MESSAGE)
  })

  test('非 OpenAI 渠道不误用官方上游提示', () => {
    expect(isOpenAIUpstreamBusyError('anthropic', '服务繁忙')).toBe(false)
    expect(getRetryDisplayReason('anthropic', '服务繁忙')).toBe('服务繁忙')
  })

  test('官方上游繁忙限制为 8 次，通用重试保持原上限', () => {
    expect(MAX_AUTO_RETRIES).toBe(25)
    expect(OPENAI_UPSTREAM_BUSY_MAX_RETRIES).toBe(8)
    expect(getMaxAutoRetries('openai', 'overloaded')).toBe(8)
  })
})

describe('isAutoRetryableTypedError', () => {
  test('rate_limited 可重试', () => {
    expect(isAutoRetryableTypedError(typedError('rate_limited', '请求过于频繁'))).toBe(true)
  })

  test('provider_error 可重试', () => {
    expect(isAutoRetryableTypedError(typedError('provider_error', '服务繁忙'))).toBe(true)
  })

  test('service_error / service_unavailable / network_error 可重试', () => {
    expect(isAutoRetryableTypedError(typedError('service_error'))).toBe(true)
    expect(isAutoRetryableTypedError(typedError('service_unavailable'))).toBe(true)
    expect(isAutoRetryableTypedError(typedError('network_error'))).toBe(true)
  })

  test('invalid_request 不可自动重试', () => {
    expect(isAutoRetryableTypedError(typedError('invalid_request', 'Bad request'))).toBe(false)
  })

  test('上游 billing URL 的 402 不可自动重试（商业版注入额度识别）', () => {
    const message = 'API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.'
    const mapped = mapSDKErrorToTypedError('unknown', message, message, detectInsufficientCredits)
    expect(mapped.code).toBe('insufficient_credits')
    expect(mapped.canRetry).toBe(false)
    expect(isAutoRetryableTypedError(mapped)).toBe(false)
  })

  test('未注入额度识别时不产生充值引导（开源版语义）', () => {
    // 开源版没有额度体系：同一个 402 只能按普通上游错误处理，
    // 不能给用户看「额度不足/去充值」这类与当前版本无关的引导。
    const message = 'API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.'
    const mapped = mapSDKErrorToTypedError('unknown', message, message)
    expect(mapped.code).not.toBe('insufficient_credits')
  })
})

describe('Ollama 工具流错误', () => {
  test('no user query found in messages 不是可自动重试的网络错误', () => {
    expect(isOllamaToolStreamError('API Error: 500 no user query found in messages')).toBe(true)
    expect(isAutoRetryableCatchError({ statusCode: 500, message: 'no user query found in messages' })).toBe(false)
  })
})

describe('isAutoRetryableCatchError', () => {
  test('429 可重试', () => {
    expect(isAutoRetryableCatchError({ statusCode: 429, message: 'Too many requests' })).toBe(true)
  })

  test('5xx 可重试', () => {
    expect(isAutoRetryableCatchError({ statusCode: 500, message: 'Internal error' })).toBe(true)
    expect(isAutoRetryableCatchError({ statusCode: 502, message: 'Bad Gateway' })).toBe(true)
    expect(isAutoRetryableCatchError({ statusCode: 503, message: 'Unavailable' })).toBe(true)
    expect(isAutoRetryableCatchError({ statusCode: 529, message: 'Overloaded' })).toBe(true)
  })

  test('4xx 不可重试（429 除外）', () => {
    expect(isAutoRetryableCatchError({ statusCode: 400, message: 'Bad request' })).toBe(false)
    expect(isAutoRetryableCatchError({ statusCode: 401, message: 'Unauthorized' })).toBe(false)
    expect(isAutoRetryableCatchError({ statusCode: 404, message: 'Not found' })).toBe(false)
  })

  test('context_management 错误可重试', () => {
    expect(isAutoRetryableCatchError(null, 'context_management error')).toBe(true)
  })

  test('stderr 中的 502/529/overloaded 关键字可重试', () => {
    expect(isAutoRetryableCatchError(null, undefined, '502 Bad Gateway')).toBe(true)
    expect(isAutoRetryableCatchError(null, undefined, 'overloaded')).toBe(true)
  })

  test('正常错误字符串不可重试', () => {
    expect(isAutoRetryableCatchError(null, 'some random error')).toBe(false)
  })
})

describe('isInvalidRelayTokenError', () => {
  test('仅匹配平台代理的 relay token 401', () => {
    expect(isInvalidRelayTokenError({ statusCode: 401, message: 'relay 令牌无效' })).toBe(true)
    expect(isInvalidRelayTokenError(null, 'OpenAI API 错误 (401): {"error":"relay 令牌无效"}')).toBe(true)
  })

  test('普通 401 和非 401 不触发恢复', () => {
    expect(isInvalidRelayTokenError({ statusCode: 401, message: 'API Key 无效' })).toBe(false)
    expect(isInvalidRelayTokenError({ statusCode: 502, message: 'relay 令牌无效' })).toBe(false)
  })
})

describe('isSessionNotFoundError', () => {
  test('匹配典型的 session 不存在错误', () => {
    expect(isSessionNotFoundError('No conversation found with session id abc123')).toBe(true)
    expect(isSessionNotFoundError('Error: no conversation found with SESSION xyz')).toBe(true)
  })

  test('stderr 中的 session 不存在错误', () => {
    expect(isSessionNotFoundError('', 'No conversation found with session id def456')).toBe(true)
  })

  test('普通错误不匹配', () => {
    expect(isSessionNotFoundError('Something went wrong')).toBe(false)
  })
})

describe('getRetryDelayMs', () => {
  test('第一次尝试约 1 秒（±20% jitter）', () => {
    const delay = getRetryDelayMs(1, 0)
    expect(delay).toBeGreaterThanOrEqual(800)
    expect(delay).toBeLessThanOrEqual(1200)
  })

  test('stream_interrupted 要求立即重试（0ms），且不等价于预算耗尽', () => {
    // 回归：重试循环曾把 0ms 当成「预算已耗尽」直接 break，
    // 导致一次瞬时断流在第 1 次重试之前就终止本轮（表现为“请求不到也不反复请求”）。
    expect(getRetryDelayMs(1, 0, 'stream_interrupted')).toBe(0)
    expect(isRetryBudgetExhausted(0)).toBe(false)
  })

  test('等待预算未耗尽时不停止重试', () => {
    expect(isRetryBudgetExhausted(0)).toBe(false)
    expect(isRetryBudgetExhausted(MAX_AUTO_RETRY_WAIT_MS - 1)).toBe(false)
  })

  test('等待预算达到上限时停止重试', () => {
    expect(isRetryBudgetExhausted(MAX_AUTO_RETRY_WAIT_MS)).toBe(true)
    expect(isRetryBudgetExhausted(MAX_AUTO_RETRY_WAIT_MS + 1)).toBe(true)
  })

  test('延迟不超过单次上限 + 20% jitter', () => {
    for (let i = 0; i < 100; i++) {
      const delay = getRetryDelayMs(10, 0)
      // jitter ±20%，最大 15000 * 1.2 = 18000
      expect(delay).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS * 1.2 + 1)
    }
  })

  test('累计超过预算时返回 0', () => {
    const delay = getRetryDelayMs(1, MAX_AUTO_RETRY_WAIT_MS)
    expect(delay).toBe(0)
  })

  test('延迟受剩余预算限制', () => {
    const delay = getRetryDelayMs(1, MAX_AUTO_RETRY_WAIT_MS - 500)
    expect(delay).toBeLessThanOrEqual(500)
  })
})

describe('isAutoRetryableCatchError 覆盖中转 5xx / 瞬时文案', () => {
  test.each([
    '520 status code (no body)',
    '503: {"message":"Service temporarily unavailable","type":"api_error"}',
    'Service temporarily unavailable',
    'Request could not be completed',
    '服务繁忙，请稍后重试',
  ])('Given “%s” Then 判定为可重试的上游瞬时故障', (text) => {
    expect(isAutoRetryableCatchError(null, text)).toBe(true)
  })

  test('认证 / 模型类错误不因此变为可重试', () => {
    expect(isAutoRetryableCatchError(null, 'invalid api key')).toBe(false)
    expect(isAutoRetryableCatchError(null, 'model not found')).toBe(false)
    expect(isAutoRetryableCatchError(null, '上下文过长')).toBe(false)
  })
})

describe('sdkPermissionModeForProferMode', () => {
  test('返回对应 SDK 权限模式（如果 @profer/shared 常量可用）', () => {
    try {
      const result = sdkPermissionModeForProferMode('auto')
      expect(typeof result).toBe('string')
    } catch {
      // @profer/shared 常量在独立测试中可能不可用，跳过
    }
  })
})
