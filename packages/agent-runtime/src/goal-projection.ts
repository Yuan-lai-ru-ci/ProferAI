import { createHash } from 'node:crypto'
import type { AgentGoalState, SDKMessage } from '@profer/shared'

/** 桌面和Core共用生命周期身份；跨文件重试仍投影到同一条消息/待办。 */
export function goalResultKey(state: AgentGoalState): string {
  return state.lifecycle?.at(-1)?.id ?? `goal:${state.id}:${state.iteration}:${state.status}`
}
export function stableGoalUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export function buildGoalVisibleResult(state: AgentGoalState): SDKMessage | undefined {
  if (!['completed', 'blocked', 'failed', 'budget_limited', 'stopped'].includes(state.status) || state.reasonCode === 'cleared' || state.stopReason === 'cleared') return undefined
  const record = state.history?.at(-1)
  const summary = state.reasonDetail || state.stopReason || record?.summary || state.lastSummary
  if (!summary) return undefined
  const key = goalResultKey(state)
  const labels: Record<string, string> = { completed: '已完成', blocked: '需要输入', failed: '执行失败', budget_limited: '预算已耗尽', stopped: '已停止' }
  const evidence = record?.evidence ?? state.lastEvidence ?? []
  const text = `Goal ${labels[state.status]}\n\n${summary}${evidence.length ? `\n\n证据：\n${evidence.map(item => `- ${item}`).join('\n')}` : ''}`
  return { type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null,
    uuid: stableGoalUuid(key), _createdAt: state.updatedAt, _goalVisibleResult: true, _goalResultKey: key } as unknown as SDKMessage
}
