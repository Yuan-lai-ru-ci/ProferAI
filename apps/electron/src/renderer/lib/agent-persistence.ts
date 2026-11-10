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
 * STREAM_COMPLETE 收尾（finalize）要做的四类副作用。
 *
 * 落盘状态只决定「实时答复能不能被丢弃」，不应该连带关掉会话列表刷新与后台任务收尾：
 * 侧栏「已停止」标记来自持久化 meta、后台任务面板来自列表 atom，两者都要靠收尾刷新，
 * 一旦被 pending/failed 整段跳过，就会残留到用户下次手动刷新为止。
 */
export interface StreamFinalizePlan {
  /** 刷新会话列表并按持久化 meta 对齐 stoppedByUser */
  refreshSessionList: boolean
  /** 清空后台任务面板 */
  clearBackgroundTasks: boolean
  /** 回收未激活会话的实时消息与流式状态（激活会话交给 AgentView 在消息加载后清理） */
  recycleInactiveSession: boolean
  /** 丢弃等待结果的写 / 改工具记录，防止内存泄漏 */
  clearPendingToolRecords: boolean
}

const NO_FINALIZE = {
  refreshSessionList: false,
  clearBackgroundTasks: false,
  recycleInactiveSession: false,
  clearPendingToolRecords: false,
} as const satisfies StreamFinalizePlan

export function decideStreamFinalize(input: {
  /** 该会话已有新一轮流在跑：任何收尾都会打断新 run */
  newStreamRunning: boolean
  /** 本轮落盘结果；undefined 表示旧链路 completion（沿用不判定的旧行为） */
  persistenceStatus?: AgentPersistenceState['status']
  /** 后台任务仍在飞行：面板要保留在跑任务，等唤醒续轮再收尾 */
  backgroundTasksPending: boolean
}): StreamFinalizePlan {
  if (input.newStreamRunning) return { ...NO_FINALIZE }
  if (input.backgroundTasksPending) return { ...NO_FINALIZE }

  // 落盘未完成（pending/failed）时实时答复仍是唯一副本，只能保留 live 与流式状态；
  // 其余收尾副作用与落盘无关，照常执行。
  const keepLive = input.persistenceStatus === 'pending' || input.persistenceStatus === 'failed'
  return {
    refreshSessionList: true,
    clearBackgroundTasks: true,
    recycleInactiveSession: !keepLive,
    clearPendingToolRecords: true,
  }
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
