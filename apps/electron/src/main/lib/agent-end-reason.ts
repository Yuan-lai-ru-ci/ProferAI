/**
 * agent-end-reason — Agent 任务结束原因统一归一化
 *
 * 纯函数模块（无副作用，可单测）。由 agent-orchestrator 的 owner finally 调用，
 * 把零散的终态信号（result subtype / stoppedByUser / 错误标志）归一化为统一的
 * AgentEndReason + 可读 label，供对话记录条目、输入框中断说明 chip、注入文本与 toast 共用。
 *
 * 判定优先级（第一个命中生效）见 normalizeAgentEndReason 内注释。
 */

import type { AgentEndReason } from '@profer/shared'

export const DELEGATION_CANCELLED_RESULT_SUBTYPE = 'delegation_cancelled'

export interface NormalizeAgentEndReasonInput {
  /** SDK result 消息的 subtype（success / error_max_turns / error_max_budget_usd / max_tokens / error_during_execution 等） */
  resultSubtype?: string
  /** 是否由用户手动停止 */
  stoppedByUser?: boolean
  /** 是否显式记录到运行级错误标志（preflight 错误 / 异常 catch / TypedError 无 subtype） */
  hasError?: boolean
}

export interface AgentEndReasonResult {
  reason: AgentEndReason
  label: string
}

/** 可读短文案：对话记录条目、chip 显示、注入文本、toast 共用 */
export const AGENT_END_REASON_LABELS: Record<AgentEndReason, string> = {
  completed: '',
  stopped_by_user: '已被用户中断',
  max_turns: '已中断：达到轮次上限',
  max_budget: '已中断：达到预算上限',
  max_tokens: '已中断：达到长度上限',
  error: '执行出错',
  unknown: '任务中断',
}

/**
 * 归一化结束原因
 *
 * 优先级（第一个命中生效）：
 * 1. stoppedByUser === true                         → stopped_by_user（用户手动停止优先于一切）
 * 2. resultSubtype === 'success'                    → completed
 * 3. resultSubtype === 'error_max_turns'            → max_turns
 * 4. resultSubtype === 'error_max_budget_usd'       → max_budget
 * 5. resultSubtype === 'max_tokens'                 → max_tokens（Pi stopReason=length 特有）
 * 6. resultSubtype === 'error_during_execution'     → error
 * 7. hasError === true（preflight / 异常 catch / TypedError 无 subtype）→ error
 * 8. resultSubtype 为已知以外的非空字符串            → unknown
 * 9. 兜底（无 subtype、无错误、未停止的干净结束）    → completed（防御：不被误判为中断）
 */
export function normalizeAgentEndReason(input: NormalizeAgentEndReasonInput): AgentEndReasonResult {
  const { resultSubtype, stoppedByUser, hasError } = input

  if (stoppedByUser === true) {
    return { reason: 'stopped_by_user', label: AGENT_END_REASON_LABELS.stopped_by_user }
  }

  if (resultSubtype === 'success') {
    return { reason: 'completed', label: AGENT_END_REASON_LABELS.completed }
  }
  if (resultSubtype === 'error_max_turns') {
    return { reason: 'max_turns', label: AGENT_END_REASON_LABELS.max_turns }
  }
  if (resultSubtype === 'error_max_budget_usd') {
    return { reason: 'max_budget', label: AGENT_END_REASON_LABELS.max_budget }
  }
  if (resultSubtype === 'max_tokens') {
    return { reason: 'max_tokens', label: AGENT_END_REASON_LABELS.max_tokens }
  }
  if (resultSubtype === 'error_during_execution') {
    return { reason: 'error', label: AGENT_END_REASON_LABELS.error }
  }
  if (resultSubtype === DELEGATION_CANCELLED_RESULT_SUBTYPE) {
    return { reason: 'unknown', label: '因父会话停止而取消' }
  }

  if (hasError === true) {
    return { reason: 'error', label: AGENT_END_REASON_LABELS.error }
  }

  if (typeof resultSubtype === 'string' && resultSubtype.length > 0) {
    return { reason: 'unknown', label: AGENT_END_REASON_LABELS.unknown }
  }

  // 兜底：干净结束（无 subtype、无错误、未停止）视为正常完成
  return { reason: 'completed', label: AGENT_END_REASON_LABELS.completed }
}
