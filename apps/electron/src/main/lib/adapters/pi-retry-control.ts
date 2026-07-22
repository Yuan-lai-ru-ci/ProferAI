import type { RetryAttempt } from '@profer/shared'

export type PiRetryUpdate =
  | { status: 'starting'; attempt: number; maxAttempts: number; delaySeconds: number; reason: string }
  | { status: 'attempt'; attemptData: RetryAttempt }
  | { status: 'cleared' }
  | { status: 'failed'; attemptData: RetryAttempt }

type PiNativeRetryEvent =
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }

/** Avoid publishing a failed turn before Pi decides whether it will continue it. */
export function createPiRetryTerminalGate<T>(): {
  defer: (error: T) => void
  settle: (willRetry: boolean) => T | undefined
} {
  let pendingError: T | undefined

  return {
    defer(error) {
      pendingError = error
    },
    settle(willRetry) {
      const terminalError = willRetry ? undefined : pendingError
      pendingError = undefined
      return terminalError
    },
  }
}

/** Convert Pi's native retry lifecycle to the retry events understood by Profer's UI. */
export function mapPiNativeRetryEvent(
  event: PiNativeRetryEvent,
  timestamp = Date.now(),
): PiRetryUpdate[] {
  if (event.type === 'auto_retry_start') {
    const delaySeconds = event.delayMs / 1_000
    const attemptData: RetryAttempt = {
      attempt: event.attempt,
      timestamp,
      reason: event.errorMessage,
      errorMessage: event.errorMessage,
      delaySeconds,
    }
    return [
      {
        status: 'starting',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delaySeconds,
        reason: event.errorMessage,
      },
      { status: 'attempt', attemptData },
    ]
  }

  if (event.success) return [{ status: 'cleared' }]
  const error = event.finalError ?? 'Unknown error'
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
