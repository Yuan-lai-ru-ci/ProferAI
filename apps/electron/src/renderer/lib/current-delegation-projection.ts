import type { AgentSessionMeta, SDKMessage } from '@profer/shared'

export interface CurrentDelegationExecution {
  taskId: string
  executionSessionId: string
  title: string
  status?: string
  resultSummary?: string
  createdAt: number
  session?: AgentSessionMeta
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined }
function resultDelegations(value: unknown, depth = 0): RecordValue[] {
  if (depth > 8) return []
  if (typeof value === 'string') { try { return resultDelegations(JSON.parse(value), depth + 1) } catch { return [] } }
  if (Array.isArray(value)) return value.flatMap(item => resultDelegations(item, depth + 1))
  const data = record(value)
  if (!data) return []
  if (data.type === 'text') return resultDelegations(data.text, depth + 1)
  if (data.delegation) return [record(data.delegation)].filter((item): item is RecordValue => !!item)
  if (Array.isArray(data.delegations)) return data.delegations.map(record).filter((item): item is RecordValue => !!item)
  return data.content ? resultDelegations(data.content, depth + 1) : []
}

/** 只读取真实 tool_result 的结构化投影，不从模型或用户正文推断派工。 */
export function currentDelegationExecutions(parentSessionId: string, sessions: readonly AgentSessionMeta[], messages: readonly SDKMessage[]): CurrentDelegationExecution[] {
  const result = new Map<string, CurrentDelegationExecution>()
  const known = new Map(sessions.map(session => [session.id, session]))
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content: unknown = record(message.message)?.content
    if (!Array.isArray(content)) continue
    for (const value of content) {
      const block = record(value)
      if (block?.type !== 'tool_result') continue
      for (const data of resultDelegations(block.content)) {
        const projection = record(data.projection)
        if (data.placement !== 'current' || data.relation === 'independent' || projection?.sessionId !== parentSessionId
          || typeof projection.executionSessionId !== 'string' || projection.executionSessionId === parentSessionId
          || typeof data.delegationId !== 'string' || projection.taskId !== data.delegationId) continue
        const session = known.get(projection.executionSessionId)
        if (session && ((session.sourceSessionId ?? session.parentSessionId) !== parentSessionId || session.delegationPlacement !== 'current' || session.delegationRelation === 'independent')) continue
        result.set(projection.executionSessionId, { taskId: data.delegationId, executionSessionId: projection.executionSessionId, title: typeof data.title === 'string' ? data.title : '当前会话任务', status: typeof data.status === 'string' ? data.status : undefined, resultSummary: typeof data.resultSummary === 'string' ? data.resultSummary : undefined, createdAt: typeof data.startedAt === 'number' ? data.startedAt : 0 })
      }
    }
  }
  for (const session of sessions) {
    if (session.id === parentSessionId || !session.sourceDelegationId || (session.sourceSessionId ?? session.parentSessionId) !== parentSessionId
      || session.delegationPlacement !== 'current' || session.delegationRelation === 'independent') continue
    result.set(session.id, { ...result.get(session.id), taskId: session.sourceDelegationId, executionSessionId: session.id, title: session.title, status: session.delegationStatus, createdAt: session.createdAt, session })
  }
  return [...result.values()].sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId))
}
