export interface AgentPersistenceState {
  status: 'pending' | 'saved' | 'failed'
  runId?: string
  startedAt?: number
  watermark?: number
  error?: string
}
interface StreamGeneration { startedAt?: number; running?: boolean }

/** 完成不等于落盘；旧代际即使 saved，也不能授权清理新一轮。 */
export function canReplaceAgentHistory(persistence: AgentPersistenceState | undefined, stream: StreamGeneration | undefined): boolean {
  return !persistence || (persistence.status === 'saved' && !stream?.running &&
    (stream?.startedAt == null || stream.startedAt === persistence.startedAt))
}

export function acceptPersistenceAck(
  current: AgentPersistenceState | undefined,
  ack: { runId?: string; status: string; watermark?: number },
  stream: StreamGeneration | undefined,
): boolean {
  if (!current || !current.runId || ack.runId !== current.runId) return false
  if (stream?.startedAt != null && stream.startedAt !== current.startedAt) return false
  return ack.watermark == null || current.watermark == null || ack.watermark >= current.watermark
}

/**
 * 收到 `session_persistence` 事件时该怎么办。
 *
 * 旧链路（agent-service 的 status publisher）发出的 ACK 不带 runId，也不存在本轮的
 * persistence 记账；这类 ACK 只能提示，不能改写当前 run 的落盘状态，否则一次跨链路的
 * 迟到事件会把新 run 的 pending 直接抹掉。
 */
export type PersistenceAckDecision = 'apply' | 'toast' | 'ignore'

export function decidePersistenceAck(
  current: AgentPersistenceState | undefined,
  ack: { runId?: string; status: string; watermark?: number },
  stream: StreamGeneration | undefined,
): PersistenceAckDecision {
  // 无身份 ACK / 无本轮记账：保留旧的“失败要提示”行为，其余一律不动状态。
  if (!current || ack.runId == null) return ack.status === 'failed' ? 'toast' : 'ignore'
  return acceptPersistenceAck(current, ack, stream) ? 'apply' : 'ignore'
}

/**
 * 读盘返回后，这份历史快照还能不能用来替换当前视图。
 *
 * - 新 run 已接管（startedAt 变化）：旧请求的内容属于上一代，丢弃，等新 run 的终态刷新。
 * - 落盘状态在读取期间变了、且现在已经 saved：读到的可能是落盘前的快照，ACK 会 bump 刷新，丢弃。
 * - 落盘状态在读取期间变成 pending/failed：磁盘仍是更早轮次的权威来源，但实时答复不能清；
 *   必须重读一次让窗口收敛（failed 不会再有任何 bump，不重读就会整段空窗）。
 * - 其余（状态没变，含进房前就已 failed 的会话）：正常应用；实时副本由调用方另行保护。
 */
export type AgentHistoryLoadDecision = 'apply' | 'retry' | 'discard'

export function decideAgentHistoryLoad(input: {
  generationAtLoad?: number
  generationNow?: number
  persistenceAtLoad?: AgentPersistenceState
  persistenceNow?: AgentPersistenceState
  streamNow?: StreamGeneration
}): AgentHistoryLoadDecision {
  if (input.generationAtLoad !== input.generationNow) return 'discard'
  if (input.persistenceAtLoad === input.persistenceNow) return 'apply'
  return canReplaceAgentHistory(input.persistenceNow, input.streamNow) ? 'discard' : 'retry'
}
