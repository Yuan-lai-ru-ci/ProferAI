import type { AgentSendInput } from '@profer/shared'

type RunOutcome = Parameters<NonNullable<AgentSendInput['onRunOutcome']>>[0]
type CompletionOptions = Parameters<NonNullable<import('./agent-orchestrator').SessionCallbacks['onComplete']>>[1]

/** 收敛运行回调的多个生命周期信号，保证 owner 最多收到一个终态。 */
export function createAgentRunOutcomeReporter(onOutcome?: (outcome: RunOutcome) => void) {
  let error: string | undefined
  let stopped = false
  let stopReason: string | undefined
  let stopSignalSeen = false
  let failed = false
  let explicitOutcomeStatus: 'completed' | 'failed' | 'stopped' | undefined
  let completionSeen = false
  let settled = false

  return {
    onError(message: string) {
      error ??= message || 'Agent 执行失败'
    },
    onComplete(options?: CompletionOptions) {
      if (options?.backgroundTasksPending) return
      completionSeen = true
      if (options?.outcomeStatus !== undefined) explicitOutcomeStatus = options.outcomeStatus
      const isStopped = options?.outcomeStatus !== undefined
        ? options.outcomeStatus === 'stopped'
        : options?.stoppedByUser === true || options?.endReason === 'stopped_by_user'
      if (isStopped) {
        if (!stopSignalSeen) {
          stopSignalSeen = true
          stopped = true
          stopReason = options?.stopReason === 'parent_cancel' || options?.stopReason === 'delegation_cancel' ? options.stopReason : undefined
        }
      }
      const errors = options?.resultErrors?.filter(value => typeof value === 'string' && value.trim())
      const failedResult = options?.outcomeStatus === undefined && options?.resultSubtype != null && options.resultSubtype !== 'success' && options.resultSubtype !== 'delegation_cancelled'
      const malformedSuccess = options?.outcomeStatus === undefined && options?.resultSubtype === 'success' && (errors?.length ?? 0) > 0
      const nonCompletedReason = options?.outcomeStatus === undefined && options?.endReason != null
        && options.endReason !== 'completed' && options.endReason !== 'stopped_by_user'
      if (options?.outcomeStatus === 'failed' || failedResult || malformedSuccess || nonCompletedReason) {
        failed = true
        error ??= errors?.join('\n') || (options?.endReasonLabel && options.endReasonLabel !== '' ? options.endReasonLabel : undefined)
          || `Agent 运行未成功${options?.resultSubtype && options.resultSubtype !== 'delegation_cancelled' ? ` (${options.resultSubtype})` : ''}`
      }
    },
    rejectBeforeStart() {
      settled = true
    },
    finish() {
      if (settled) return
      settled = true
      if (explicitOutcomeStatus === 'stopped' || stopped) {
        try { onOutcome?.({ status: 'stopped', ...(stopReason ? { stopReason } : {}) }) } catch { /* 外部观察者不能改变运行结果 */ }
      } else if (explicitOutcomeStatus === 'completed') {
        try { onOutcome?.({ status: 'completed' }) } catch { /* 外部观察者不能改变运行结果 */ }
      } else if (explicitOutcomeStatus === 'failed' || failed || error || !completionSeen) {
        try { onOutcome?.({ status: 'failed', error: error ?? 'Agent 未产生运行终态' }) } catch { /* 外部观察者不能改变运行结果 */ }
      } else {
        try { onOutcome?.({ status: 'completed' }) } catch { /* 外部观察者不能改变运行结果 */ }
      }
    },
  }
}
