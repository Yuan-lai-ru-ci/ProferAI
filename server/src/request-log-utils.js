/**
 * 请求日志 SQL 工具
 *
 * 把 request_logs 的列、占位符和值顺序集中到一起，避免列数和值数漂移。
 */
export const REQUEST_LOG_COLUMNS = Object.freeze([
  'id',
  'user_id',
  'model',
  'provider',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'cost_credits',
  'duration_ms',
  'success',
  'stream',
  'error_message',
  'created_at',
  'new_api_request_id',
])

export function buildRequestLogInsertSql() {
  const placeholders = REQUEST_LOG_COLUMNS.map(() => '?').join(', ')
  return `INSERT INTO request_logs (${REQUEST_LOG_COLUMNS.join(', ')}) VALUES (${placeholders})`
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function buildRequestLogValues(params, createdAt = Date.now()) {
  const {
    id,
    userId,
    model,
    provider,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costCredits,
    durationMs,
    success,
    stream,
    errorMessage,
    newApiRequestId,
  } = params

  return [
    id,
    userId,
    model || '',
    provider || '',
    toNumber(promptTokens),
    toNumber(completionTokens),
    toNumber(totalTokens),
    toNumber(cacheCreationTokens),
    toNumber(cacheReadTokens),
    toNumber(costCredits),
    toNumber(durationMs),
    success ? 1 : 0,
    stream ? 1 : 0,
    errorMessage || '',
    createdAt,
    newApiRequestId || '',
  ]
}
