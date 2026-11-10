import type { AgentRuntimeCompletionSignal, AgentRunOutcome } from './events'

export interface AgentRunOutcomeReporter {
  onError(message: string): void
  onComplete(signal?: AgentRuntimeCompletionSignal): void
  rejectBeforeStart(): void
  finish(): AgentRunOutcome | undefined
}

/** 收敛 runtime 的错误、完成和停止信号，保证一次 run 最多产生一个终态。 */
export function createAgentRunOutcomeReporter(
  onOutcome?: (outcome: AgentRunOutcome) => void,
): AgentRunOutcomeReporter {
  let error: string | undefined
  let stopped = false
  let stopReason: string | undefined
  let stopSignalSeen = false
  let failed = false
  let explicitOutcomeStatus: 'completed' | 'failed' | 'stopped' | undefined
  let completionSeen = false
  let settled = false
  let outcome: AgentRunOutcome | undefined

  const report = (next: AgentRunOutcome): AgentRunOutcome => {
    outcome = next
    try {
      onOutcome?.(next)
    } catch {
      // 外部观察者不能改变 runtime 的终态。
    }
    return next
  }

  return {
    onError(message) {
      error ??= message || 'Agent 执行失败'
    },
    onComplete(signal) {
      if (signal?.backgroundTasksPending) return
      completionSeen = true
      if (signal?.outcomeStatus !== undefined) explicitOutcomeStatus = signal.outcomeStatus
      const errors = signal?.resultErrors?.filter((value) => value.trim()) ?? []
      const isStopped = signal?.outcomeStatus !== undefined
        ? signal.outcomeStatus === 'stopped'
        : signal?.stoppedByUser === true
      if (isStopped) {
        if (!stopSignalSeen) {
          stopSignalSeen = true
          stopped = true
          stopReason = signal?.stopReason === 'parent_cancel' || signal?.stopReason === 'delegation_cancel' ? signal.stopReason : undefined
        }
      }
      const failedResult = signal?.outcomeStatus === undefined && signal?.resultSubtype !== undefined
        && signal.resultSubtype !== 'success' && signal.resultSubtype !== 'delegation_cancelled'
      const malformedSuccess = signal?.outcomeStatus === undefined && signal?.resultSubtype === 'success' && errors.length > 0
      const nonCompletedReason = signal?.outcomeStatus === undefined && signal?.endReason !== undefined
        && signal.endReason !== 'completed' && signal.endReason !== 'stopped_by_user'
      if (signal?.outcomeStatus === 'failed' || failedResult || malformedSuccess || nonCompletedReason) {
        failed = true
        error ??= errors.join('\n') || signal?.endReasonLabel || `Agent 运行未成功${signal?.resultSubtype && signal.resultSubtype !== 'delegation_cancelled' ? ` (${signal.resultSubtype})` : ''}`
      }
    },
    rejectBeforeStart() {
      settled = true
    },
    finish() {
      if (settled) return outcome
      settled = true
      if (explicitOutcomeStatus === 'stopped' || stopped) return report({ status: 'stopped', ...(stopReason ? { stopReason } : {}) })
      if (explicitOutcomeStatus === 'completed') return report({ status: 'completed' })
      if (explicitOutcomeStatus === 'failed' || failed || error || !completionSeen) return report({ status: 'failed', error: error ?? 'Agent 未产生运行终态' })
      return report({ status: 'completed' })
    },
  }
}
