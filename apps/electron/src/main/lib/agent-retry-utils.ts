/**
 * Agent 重试工具函数
 *
 * 从 agent-orchestrator.ts 提取的纯函数，用于自动重试决策和延迟计算。
 */
import type { TypedError, ProferPermissionMode } from '@profer/shared'
import { PROFER_PERMISSION_MODE_CONFIG } from '@profer/shared'
import { isTransientNetworkError, isMalformedResponseError, classifyNetworkError, getCategoryRetryDelayMultiplier, type NetworkErrorCategory } from './error-patterns'

/** 可自动重试的 TypedError 错误码 */
export const AUTO_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'provider_error',
  'service_error',
  'service_unavailable',
  'network_error',
])

/** 最大自动重试次数 */
export const MAX_AUTO_RETRIES = 25

/** 自动重试累计等待预算（毫秒） */
export const MAX_AUTO_RETRY_WAIT_MS = 5 * 60_000

/** 重试单次延迟上限（毫秒） */
export const RETRY_MAX_DELAY_MS = 15_000

/**
 * Ollama Anthropic 兼容层在 Qwen3.8 的 tool_result 续请求上可能返回此协议错误。
 * 它不是网络断流；重复提交相同上下文可能让 Ollama runner 长时间占用，因此禁止自动重试。
 */
export function isOllamaToolStreamError(...messages: Array<string | undefined>): boolean {
  return messages.some((message) => typeof message === 'string' && /no user query found in messages/i.test(message))
}

export function sdkPermissionModeForProferMode(mode: ProferPermissionMode): ProferPermissionMode {
  return PROFER_PERMISSION_MODE_CONFIG[mode].sdkMode
}

/**
 * 从 stderr 中提取 API 错误信息
 */
export function extractApiError(stderr: string): { statusCode: number; message: string } | null {
  if (!stderr) return null

  const jsonMatch = stderr.match(/(\d{3})\s+(\{[^}]*"error"[^}]*\})/s)
  if (jsonMatch) {
    try {
      const statusCode = parseInt(jsonMatch[1]!)
      const errorObj = JSON.parse(jsonMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch { /* fall through */ }
  }

  const apiErrorMatch = stderr.match(/API error[^:]*:\s+(\d{3})\s+\d{3}\s+(\{.*?\})/s)
  if (apiErrorMatch) {
    try {
      const statusCode = parseInt(apiErrorMatch[1]!)
      const errorObj = JSON.parse(apiErrorMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch { /* fall through */ }
  }

  const simpleMatch = stderr.match(/(\d{3})[:\s]+(.+?)(?:\n|$)/i)
  if (simpleMatch) {
    const statusCode = parseInt(simpleMatch[1]!)
    const message = simpleMatch[2]!.trim()
    if (statusCode >= 400 && statusCode < 600) {
      return { statusCode, message }
    }
  }

  return null
}

export function isAutoRetryableTypedError(error: TypedError): boolean {
  return AUTO_RETRYABLE_ERROR_CODES.has(error.code)
}

export function isAutoRetryableCatchError(
  apiError: { statusCode: number; message: string } | null,
  rawErrorMessage?: string,
  stderr?: string,
): boolean {
  if (isOllamaToolStreamError(apiError?.message, rawErrorMessage, stderr)) return false
  if (apiError) {
    if (apiError.statusCode === 429 || apiError.statusCode >= 500) return true
  }
  if (rawErrorMessage) {
    if (rawErrorMessage.includes('context_management')) return true
  }
  const text = `${rawErrorMessage ?? ''}\n${stderr ?? ''}`
  if (/\b502\b|\b529\b|overloaded/i.test(text)) return true
  if (isTransientNetworkError(rawErrorMessage, stderr)) return true
  if (isMalformedResponseError(rawErrorMessage, stderr)) return true
  return false
}

export function isSessionNotFoundError(errorMessage: string, stderr?: string): boolean {
  const pattern = /No conversation found.*with session/i
  return pattern.test(errorMessage) || (!!stderr && pattern.test(stderr))
}

/** 仅识别平台代理的 relay token 轮换，避免把普通 API Key 的 401 误判为可恢复故障。 */
export function isInvalidRelayTokenError(
  apiError: { statusCode: number; message: string } | null,
  rawErrorMessage?: string,
  stderr?: string,
): boolean {
  if (apiError?.statusCode !== 401 && !/\b401\b/.test(`${rawErrorMessage ?? ''}\n${stderr ?? ''}`)) return false
  return /relay 令牌无效/i.test(`${apiError?.message ?? ''}\n${rawErrorMessage ?? ''}\n${stderr ?? ''}`)
}

/**
 * 计算重试延迟（指数退避 + ±20% jitter）
 *
 * @param attempt 当前重试尝试次数（从 1 开始）
 * @param elapsedRetryDelayMs 已累计的重试等待时间
 * @param errorCategory 可选的网络错误分类，用于调整退避倍数。
 *   stream_interrupted → 立即重试（0ms）；
 *   timeout → ×1.5；dns/connection_refused → ×2。
 */
export function getRetryDelayMs(
  attempt: number,
  elapsedRetryDelayMs: number,
  errorCategory?: NetworkErrorCategory,
): number {
  const remainingMs = MAX_AUTO_RETRY_WAIT_MS - elapsedRetryDelayMs
  if (remainingMs <= 0) return 0

  const base = Math.min(1000 * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS)
  const multiplier = errorCategory ? getCategoryRetryDelayMultiplier(errorCategory) : 1.0
  const jitter = base * (Math.random() * 0.4 - 0.2)
  return Math.min(remainingMs, Math.max(0, Math.round((base + jitter) * multiplier)))
}

/**
 * 从原始错误消息中提取网络错误分类
 *
 * 供 orchestrator 在捕获 catch 错误后使用，
 * 将分类信息传入 getRetryDelayMs 以实现差异化退避。
 */
export function classifyCatchError(rawErrorMessage?: string, stderr?: string): NetworkErrorCategory {
  return classifyNetworkError(rawErrorMessage, stderr)
}
