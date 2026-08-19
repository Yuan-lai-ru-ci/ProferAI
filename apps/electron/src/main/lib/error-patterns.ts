/**
 * 瞬时网络错误模式
 *
 * 覆盖上游 API 偶发断流/抖动：API SSE 流中途 terminated、TCP 连接被重置、
 * DNS 抖动、fetch 层超时、连接被中止（undici "The operation was aborted" /
 * AbortError）、对端提前关闭等。这些错误无 HTTP 状态码，SDK HTTP 客户端层
 * 内置的 2 次重试无法完全消化时，会穿透到 Orchestrator 应用层兜底。
 * 命中此模式的错误会走「保留 resume 的自动重试」，不会清除 sdkSessionId（#903）。
 *
 * 同时覆盖 OpenAI/Anthropic provider 的流中断错误：
 * - "stream ended before a terminal response event"（OpenAI Responses API）
 * - "stream ended before message_stop"（Anthropic Messages API）
 * 这两种是 provider 连接被 CDN/网关切断的同类瞬时错误，与 ECONNRESET 性质一致。
 */
export const TRANSIENT_NETWORK_PATTERN =
  /terminated|socket hang up|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network error|connection (?:error|closed|reset)|other side closed|AbortError|(?:operation|request) was aborted|(?:request )?timed out|(?:upstream response )?stream was interrupted|stream (?:closed|ended|disconnected) prematurely|premature close|peer closed connection|incomplete chunked read|stream ended before (?:a )?(?:terminal response event|message_stop)/i

/** 判断错误消息/stderr 是否为瞬时网络错误 */
export function isTransientNetworkError(message?: string, stderr?: string): boolean {
  if (!message && !stderr) return false
  return (
    (!!message && TRANSIENT_NETWORK_PATTERN.test(message)) ||
    (!!stderr && TRANSIENT_NETWORK_PATTERN.test(stderr))
  )
}

// ===== 网络异常细分类（Proma #1267 对齐） =====

/**
 * 网络错误子类型
 *
 * 将瞬时网络错误细分为具体类别，支持差异化重试策略和更精确的 UI 错误提示。
 * - dns：DNS 解析失败，重试间隔应较长（DNS TTL 缓存过期后可能恢复）
 * - connection_refused：对端拒绝连接，通常需较长等待
 * - connection_reset：TCP 连接被重置（最常见，瞬时性强）
 * - timeout：连接/请求超时
 * - stream_interrupted：HTTP chunked/SSE 流中途断开（可立即重试）
 * - parse_error：上游返回非 JSON 响应（网关 HTML 错误页等）
 * - unknown：无法识别具体子类型
 */
export type NetworkErrorCategory =
  | 'dns'
  | 'connection_refused'
  | 'connection_reset'
  | 'timeout'
  | 'stream_interrupted'
  | 'parse_error'
  | 'unknown'

/** DNS 相关错误 */
const DNS_PATTERN = /ENOTFOUND|EAI_AGAIN/i

/** 连接被拒 */
const CONNECTION_REFUSED_PATTERN = /ECONNREFUSED/i

/** TCP 连接重置/管道断开 */
const CONNECTION_RESET_PATTERN = /ECONNRESET|ECONNABORTED|EPIPE|socket hang up/i

/** 超时 */
const TIMEOUT_PATTERN = /ETIMEDOUT|(?:request )?timed out/i

/** HTTP chunked/SSE 流中断（可立即重试，无需退避等待） */
const STREAM_INTERRUPTED_PATTERN =
  /(?:upstream response )?stream was interrupted|stream (?:closed|ended|disconnected) prematurely|premature close|incomplete chunked read|stream ended before (?:a )?(?:terminal response event|message_stop)|peer closed connection/i

/**
 * 将瞬时网络错误细分为具体类别
 *
 * 优先级：parse_error > stream_interrupted > timeout > dns >
 *         connection_refused > connection_reset > unknown
 *
 * @param message 错误消息（可选）
 * @param stderr 标准错误输出（可选）
 * @returns 网络错误子类型分类
 */
export function classifyNetworkError(message?: string, stderr?: string): NetworkErrorCategory {
  const text = `${message ?? ''}\n${stderr ?? ''}`

  if (!text.trim()) return 'unknown'

  // 响应体解析失败（网关 HTML 等）
  if (MALFORMED_RESPONSE_PATTERN.test(text)) return 'parse_error'

  // HTTP chunked/SSE 流中断——可立即重试
  if (STREAM_INTERRUPTED_PATTERN.test(text)) return 'stream_interrupted'

  // 超时
  if (TIMEOUT_PATTERN.test(text)) return 'timeout'

  // DNS 解析失败
  if (DNS_PATTERN.test(text)) return 'dns'

  // 连接被拒
  if (CONNECTION_REFUSED_PATTERN.test(text)) return 'connection_refused'

  // TCP 连接重置
  if (CONNECTION_RESET_PATTERN.test(text)) return 'connection_reset'

  // 其他瞬时错误（fetch failed, network error, AbortError 等）
  if (TRANSIENT_NETWORK_PATTERN.test(text)) return 'unknown'

  return 'unknown'
}

/**
 * 根据网络错误类别推荐重试延迟（毫秒）
 *
 * - stream_interrupted：0ms（立即重试，流中断通常瞬时恢复）
 * - connection_reset：默认退避（瞬时性强）
 * - timeout：默认退避 ×1.5（可能需要更长时间恢复）
 * - dns / connection_refused：默认退避 ×2（DNS/服务恢复较慢）
 * - parse_error：默认退避（网关重启通常较快）
 */
export function getCategoryRetryDelayMultiplier(category: NetworkErrorCategory): number {
  switch (category) {
    case 'stream_interrupted':
      return 0 // 立即重试
    case 'connection_reset':
    case 'parse_error':
    case 'unknown':
      return 1.0 // 默认退避
    case 'timeout':
      return 1.5
    case 'dns':
    case 'connection_refused':
      return 2.0
  }
}

/**
 * 上游响应体解析失败模式
 *
 * SDK native CLI（Bun/JavaScriptCore）将上游响应解析为 JSON 失败时抛出，
 * 典型形如 "API Error: JSON Parse error: Unable to parse JSON string"。
 * 成因多为网关返回 HTML 错误页、SSE 流被截断、代理注入脏数据等瞬时异常，
 * 与瞬时网络错误同属上游抖动，重试通常即可恢复。
 * 同时覆盖 V8 引擎措辞（Unexpected end of JSON input / is not valid JSON）。
 */
export const MALFORMED_RESPONSE_PATTERN =
  /JSON Parse error|Unable to parse JSON|Unexpected end of JSON input|Unexpected token.*JSON|is not valid JSON/i

/** 判断错误消息/stderr 是否为上游响应体解析失败 */
export function isMalformedResponseError(message?: string, stderr?: string): boolean {
  if (!message && !stderr) return false
  return (
    (!!message && MALFORMED_RESPONSE_PATTERN.test(message)) ||
    (!!stderr && MALFORMED_RESPONSE_PATTERN.test(stderr))
  )
}
