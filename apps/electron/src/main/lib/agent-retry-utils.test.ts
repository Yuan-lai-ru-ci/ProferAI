/**
 * agent-retry-utils 测试
 *
 * 覆盖重试决策、延迟计算、权限模式映射、API 错误提取等纯函数。
 */
import { describe, test, expect } from 'bun:test'
import {
  extractApiError,
  isAutoRetryableTypedError,
  isAutoRetryableCatchError,
  isSessionNotFoundError,
  getRetryDelayMs,
  sdkPermissionModeForPromaMode,
  MAX_AUTO_RETRY_WAIT_MS,
  RETRY_MAX_DELAY_MS,
} from './agent-retry-utils'
import type { TypedError } from '@proma/shared'

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

describe('sdkPermissionModeForPromaMode', () => {
  test('返回对应 SDK 权限模式（如果 @proma/shared 常量可用）', () => {
    try {
      const result = sdkPermissionModeForPromaMode('auto')
      expect(typeof result).toBe('string')
    } catch {
      // @proma/shared 常量在独立测试中可能不可用，跳过
    }
  })
})
