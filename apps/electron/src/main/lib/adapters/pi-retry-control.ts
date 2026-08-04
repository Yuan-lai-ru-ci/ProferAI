import type { RetryAttempt } from '@profer/shared'

export type PiRetryUpdate =
  | { status: 'starting'; attempt: number; maxAttempts: number; delaySeconds: number; reason: string }
  | { status: 'attempt'; attemptData: RetryAttempt }
  | { status: 'cleared' }
  | { status: 'failed'; attemptData: RetryAttempt }

/**
 * Pi native retry 事件（对齐 @earendil-works/pi-coding-agent@0.82.1 + Profer 引入的
 * `pi-coding-agent@0.82.1.patch` 扩展）。
 *
 * SDK 0.82.1（含 patch）的 retry 生命周期比 0.80.9 多了一个阶段：
 *   auto_retry_start          —— 已安排 retry，正在 backoff，尚未重新发起模型请求
 *   auto_retry_attempt_start  —— backoff 结束，紧邻 agent.continue() 的实际 retry 请求（新）
 *   auto_retry_end            —— 收尾，outcome 区分 succeeded / exhausted / cancelled
 *
 * 除 outcome 外的字段均来自 SDK 的 _getRetryEventDetails。total* 系列为 backoff total 预算
 * 语义（跨多个模型回合的累计），对 Profer 的尝试计数器无直接影响，故保持可选兼容。
 */
type PiNativeRetryDetails = {
  attempt: number
  maxAttempts: number
  totalAttempt?: number
  maxTotalAttempts?: number
  delayMs: number
  totalDelayMs?: number
  maxTotalDelayMs?: number
  errorMessage?: string
}

type PiNativeRetryEvent =
  | ({ type: 'auto_retry_start' } & PiNativeRetryDetails)
  | ({ type: 'auto_retry_attempt_start' } & PiNativeRetryDetails)
  | ({ type: 'auto_retry_end'; success: boolean; outcome?: 'succeeded' | 'exhausted' | 'cancelled'; finalError?: string } & PiNativeRetryDetails)

/**
 * Pi native retry 的终态事件门控。
 *
 * Pi 在判定可重试时会先结束一次失败的 agent loop，再在同一 transcript 上 continue。
 * 在确认 `willRetry` 前，调用方不能把 error 或 result 当作最终状态交给外层编排器。
 */
export function createPiRetryTerminalGate<T>(): {
  defer: (error: T) => void
  peek: () => T | undefined
  settle: (willRetry: boolean) => T | undefined
} {
  let pendingError: T | undefined

  return {
    defer(error) {
      pendingError = error
    },
    peek() {
      return pendingError
    },
    settle(willRetry) {
      const terminalError = willRetry ? undefined : pendingError
      pendingError = undefined
      return terminalError
    },
  }
}

/**
 * 将 Pi native retry 生命周期转换为 Profer UI 已识别的 retry 事件。
 *
 * 映射关系（对齐 SDK 0.82.1 三个阶段的语义）：
 *   auto_retry_start          -> starting（backoff 开始）
 *   auto_retry_attempt_start  -> attempt（实际重试请求开始，记录本次退避等待时长）
 *   auto_retry_end            -> cleared / failed（success 或 outcome==='succeeded' 为 cleared）
 *
 * outcome === 'cancelled' 表示 retry 被中断/取消（例如用户停止），此时 UI 已被 stopped
 * 流程接管，返回 cleared 避免误报一个失败的最终 attemptData。
 */
export function mapPiNativeRetryEvent(
  event: PiNativeRetryEvent,
  timestamp = Date.now(),
): PiRetryUpdate[] {
  if (event.type === 'auto_retry_start') {
    return [{
      status: 'starting',
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delaySeconds: event.delayMs / 1_000,
      reason: event.errorMessage ?? '未知错误',
    }]
  }

  if (event.type === 'auto_retry_attempt_start') {
    const errorMessage = event.errorMessage ?? '重试中'
    return [{
      status: 'attempt',
      attemptData: {
        attempt: event.attempt,
        timestamp,
        reason: errorMessage,
        errorMessage,
        delaySeconds: event.delayMs / 1_000,
      },
    }]
  }

  // auto_retry_end
  if (event.success || event.outcome === 'succeeded') {
    return [{ status: 'cleared' }]
  }

  if (event.outcome === 'cancelled') {
    // retry 被取消：不当作失败终态上报，避免污染 by stopped 流程的 UI 状态机。
    return [{ status: 'cleared' }]
  }

  const error = event.finalError ?? '重试失败'
  return [{
    status: 'failed',
    attemptData: {
      attempt: event.attempt,
      timestamp,
      reason: error,
      errorMessage: error,
      delaySeconds: 0,
    },
  }]
}
