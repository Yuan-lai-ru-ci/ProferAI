import type { SDKMessage, SDKUserMessage } from '@profer/shared'
import { isGoalIterationMessage, readMessageProvenance } from '@profer/shared'
import { extractUserText, isUserInputMessage } from '@profer/session-core'

/** 可信来源优先；旧历史只兼容原有定时标记，不从当前会话推断具体来源。 */
export function isScheduledTaskInput(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const userMessage = message as SDKUserMessage
  if (!isUserInputMessage(userMessage)) return false
  const provenance = readMessageProvenance(message._provenance)
  if (provenance) return provenance.source?.type === 'automation' || provenance.author.type === 'automation'
  return (extractUserText(userMessage) ?? '').includes('<!--PROMA_SCHEDULED_RUN-->')
}

export function isTaskSourceInput(message: SDKMessage): boolean {
  if (message.type !== 'user' || isGoalIterationMessage(message)) return false
  const userMessage = message as SDKUserMessage
  if (!isUserInputMessage(userMessage)) return false
  if (isScheduledTaskInput(message)) return true
  const provenance = readMessageProvenance(message._provenance)
  return provenance !== undefined && ['agent', 'external', 'system'].includes(provenance.author.type)
}

function occurrenceKey(message: SDKMessage): string | undefined {
  const provenance = readMessageProvenance(message._provenance)
  return provenance?.triggerId ? JSON.stringify([provenance.runId, provenance.triggerId]) : undefined
}

/** 正文到达后由输入卡承载触发事实；原始 transcript 保留，分页缺正文时仍显示提示。 */
export function projectTaskInputTimeline(messages: readonly SDKMessage[]): SDKMessage[] {
  const inputs = new Set(messages.filter(isTaskSourceInput).map(occurrenceKey).filter(key => key !== undefined))
  return messages.filter(message => {
    if (message.type !== 'system' || message.subtype !== 'task_trigger') return true
    const key = occurrenceKey(message)
    return key === undefined || !inputs.has(key)
  })
}
