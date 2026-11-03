import { describe, expect, test } from 'bun:test'
import { isTransientNetworkError, isMalformedResponseError, isTransientUpstreamText, classifyNetworkError, getCategoryRetryDelayMultiplier, isEphemeralTransportError, isRecoveredEphemeralTransportError, type NetworkErrorCategory } from './error-patterns'

describe('isTransientNetworkError', () => {
  // 原有覆盖：确保扩展正则未回归
  test.each([
    'terminated',
    'socket hang up',
    'read ECONNRESET',
    'connect ETIMEDOUT 1.2.3.4:443',
    'write EPIPE',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'TypeError: fetch failed',
    'network error',
    'stream closed prematurely',
    'premature close',
    'peer closed connection',
    'incomplete chunked read',
    'Upstream response stream was interrupted',
    'Upstream HTTP/2 stream failed',
  ])('Given 已知瞬时网络错误 "%s" Then 判定为可重试', (msg) => {
    expect(isTransientNetworkError(msg)).toBe(true)
  })

  // #903 新增覆盖：这些断连此前会绕过自动重试、误入终止分支并清除 sdkSessionId
  test.each([
    'The operation was aborted',
    'This operation was aborted',
    'AbortError: The operation was aborted',
    'Connection error.',
    'connection closed',
    'Connection reset by peer',
    'other side closed',
    'request was aborted',
    'request timed out',
    'connect ECONNABORTED',
  ])('Given #903 断连错误 "%s" Then 也判定为可重试', (msg) => {
    expect(isTransientNetworkError(msg)).toBe(true)
  })

  test('Given stderr 含瞬时网络错误 Then 判定为可重试', () => {
    expect(isTransientNetworkError(undefined, 'undici: other side closed')).toBe(true)
  })

  test('Given 普通业务错误 Then 不判定为瞬时网络错误', () => {
    expect(isTransientNetworkError('invalid api key')).toBe(false)
    expect(isTransientNetworkError('400 Bad Request: model not found')).toBe(false)
    expect(isTransientNetworkError()).toBe(false)
  })
})

describe('isEphemeralTransportError', () => {
  test('Given HTTP/2 上游流错误 Then 判定为仅当前轮展示的临时错误', () => {
    expect(isEphemeralTransportError('unknown_error', 'Upstream HTTP/2 stream failed')).toBe(true)
    expect(classifyNetworkError('Upstream HTTP/2 stream failed')).toBe('stream_interrupted')
  })

  test('Given 业务错误 Then 仍允许写入会话历史', () => {
    expect(isEphemeralTransportError('provider_error', 'model not found')).toBe(false)
    expect(isEphemeralTransportError('prompt_too_long', '上下文过长')).toBe(false)
  })

  test('Given network_error 类型 Then 即使文案变化也不污染历史', () => {
    expect(isEphemeralTransportError('network_error', '连接失败')).toBe(true)
  })
})

describe('isTransientUpstreamText（中转中文瞬时文案，与 pi-ai patch 对齐）', () => {
  test.each([
    '服务繁忙，请稍后重试',
    'OpenAI 官方上游服务当前请求量较大，暂时无法及时响应',
  ])('Given “%s” Then 判定为可重试的中转瞬时文案', (text) => {
    expect(isTransientUpstreamText(text)).toBe(true)
  })

  test.each(['invalid api key', '上下文过长', ''])('Given “%s” Then 不误判', (text) => {
    expect(isTransientUpstreamText(text)).toBe(false)
  })
})

describe('isRecoveredEphemeralTransportError（只有已恢复的断流才丢弃）', () => {
  test('Given 会话尾部的失败断流 Then 不从历史丢弃（保证用户能看到失败）', () => {
    expect(isRecoveredEphemeralTransportError(false, 'unknown_error', 'Upstream response stream was interrupted')).toBe(false)
    expect(isRecoveredEphemeralTransportError(false, 'network_error', 'Connection error.')).toBe(false)
    expect(isRecoveredEphemeralTransportError(false, 'unknown_error', 'peer closed connection')).toBe(false)
  })

  test('Given 断流之后已恢复 Then 丢弃旧卡片', () => {
    expect(isRecoveredEphemeralTransportError(true, 'unknown_error', 'Upstream response stream was interrupted')).toBe(true)
    expect(isRecoveredEphemeralTransportError(true, 'network_error', 'Connection error.')).toBe(true)
  })

  test('Given 已恢复但是业务错误 Then 不丢弃', () => {
    expect(isRecoveredEphemeralTransportError(true, 'provider_error', 'model not found')).toBe(false)
    expect(isRecoveredEphemeralTransportError(true, 'prompt_too_long', '上下文过长')).toBe(false)
  })
})

describe('isMalformedResponseError', () => {
  test('Given JSON 解析失败 Then 判定为响应体解析失败', () => {
    expect(isMalformedResponseError('API Error: JSON Parse error: Unable to parse JSON string')).toBe(true)
    expect(isMalformedResponseError('Unexpected end of JSON input')).toBe(true)
  })

  test('Given 普通错误 Then 不判定为响应体解析失败', () => {
    expect(isMalformedResponseError('socket hang up')).toBe(false)
  })
})

// ===== 网络异常细分类测试（Profer #1267 对齐） =====

describe('classifyNetworkError', () => {
  test('Given DNS 错误 Then 分类为 dns', () => {
    expect(classifyNetworkError('getaddrinfo ENOTFOUND api.openai.com')).toBe('dns')
    expect(classifyNetworkError('getaddrinfo EAI_AGAIN api.anthropic.com')).toBe('dns')
  })

  test('Given 连接被拒 Then 分类为 connection_refused', () => {
    expect(classifyNetworkError('connect ECONNREFUSED 127.0.0.1:443')).toBe('connection_refused')
  })

  test('Given TCP 连接重置 Then 分类为 connection_reset', () => {
    expect(classifyNetworkError('read ECONNRESET')).toBe('connection_reset')
    expect(classifyNetworkError('socket hang up')).toBe('connection_reset')
    expect(classifyNetworkError('write EPIPE')).toBe('connection_reset')
  })

  test('Given 超时 Then 分类为 timeout', () => {
    expect(classifyNetworkError('connect ETIMEDOUT 1.2.3.4:443')).toBe('timeout')
    expect(classifyNetworkError('request timed out')).toBe('timeout')
  })

  test('Given HTTP chunked/SSE 流中断 Then 分类为 stream_interrupted', () => {
    expect(classifyNetworkError('stream closed prematurely')).toBe('stream_interrupted')
    expect(classifyNetworkError('premature close')).toBe('stream_interrupted')
    expect(classifyNetworkError('incomplete chunked read')).toBe('stream_interrupted')
    expect(classifyNetworkError('stream ended before a terminal response event')).toBe('stream_interrupted')
    expect(classifyNetworkError('stream ended before message_stop')).toBe('stream_interrupted')
    expect(classifyNetworkError('peer closed connection')).toBe('stream_interrupted')
    expect(classifyNetworkError('Upstream response stream was interrupted')).toBe('stream_interrupted')
    expect(classifyNetworkError('Response stream was interrupted')).toBe('stream_interrupted')
  })

  test('Given 响应体解析失败 Then 分类为 parse_error（优先级高于 stream）', () => {
    expect(classifyNetworkError('API Error: JSON Parse error: Unable to parse JSON string')).toBe('parse_error')
    expect(classifyNetworkError('Unexpected end of JSON input')).toBe('parse_error')
  })

  test('Given 其他瞬时网络错误 Then 分类为 unknown', () => {
    expect(classifyNetworkError('TypeError: fetch failed')).toBe('unknown')
    expect(classifyNetworkError('network error')).toBe('unknown')
    expect(classifyNetworkError('The operation was aborted')).toBe('unknown')
  })

  test('Given 空输入 Then 分类为 unknown', () => {
    expect(classifyNetworkError()).toBe('unknown')
    expect(classifyNetworkError('')).toBe('unknown')
  })

  test('Given stderr 含网络错误 Then 正确分类', () => {
    expect(classifyNetworkError(undefined, 'undici: other side closed')).toBe('unknown')
    expect(classifyNetworkError(undefined, 'read ECONNRESET')).toBe('connection_reset')
  })

  test('Given 普通业务错误 Then 分类为 unknown', () => {
    expect(classifyNetworkError('invalid api key')).toBe('unknown')
    expect(classifyNetworkError('model not found')).toBe('unknown')
  })
})

describe('getCategoryRetryDelayMultiplier', () => {
  test('stream_interrupted 返回 0（立即重试）', () => {
    expect(getCategoryRetryDelayMultiplier('stream_interrupted')).toBe(0)
  })

  test('connection_reset / parse_error / unknown 返回 1.0（默认退避）', () => {
    expect(getCategoryRetryDelayMultiplier('connection_reset')).toBe(1.0)
    expect(getCategoryRetryDelayMultiplier('parse_error')).toBe(1.0)
    expect(getCategoryRetryDelayMultiplier('unknown')).toBe(1.0)
  })

  test('timeout 返回 1.5', () => {
    expect(getCategoryRetryDelayMultiplier('timeout')).toBe(1.5)
  })

  test('dns / connection_refused 返回 2.0', () => {
    expect(getCategoryRetryDelayMultiplier('dns')).toBe(2.0)
    expect(getCategoryRetryDelayMultiplier('connection_refused')).toBe(2.0)
  })
})
