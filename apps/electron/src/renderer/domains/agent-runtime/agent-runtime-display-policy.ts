/** 显示层只消费运行事实；不释放 owner，不调用宿主，也不从正文推断模型是否仍在执行。 */
export interface AgentSessionMetaLike {
  parentSessionId?: string
  sourceDelegationId?: string
  delegationStatus?: string
  explorationParentSessionId?: string
}

/** 显示域只按持久化委派状态计数；探索分支和普通子会话不混入。 */
export function countRunningDelegations(sessions: readonly AgentSessionMetaLike[], parentSessionId: string): number {
  return sessions.filter((session) => (
    session.parentSessionId === parentSessionId
    && Boolean(session.sourceDelegationId)
    && !session.explorationParentSessionId
    && session.delegationStatus === 'running'
  )).length
}

/** 运行事实投影。 */
export interface AgentRuntimeDisplayFacts {
  running: boolean
  stopping?: boolean
  backgroundWaiting?: boolean
  isCompacting?: boolean
  /** 本轮 run 就是一次手动压缩（含收尾窗口）；自动压缩不置位。 */
  compactInFlight?: boolean
  retrying?: boolean
  retryFailed?: boolean
  streamError?: string | null
  liveMessages?: readonly { type: string; error?: unknown }[]
  runningDelegationCount?: number
}

export interface AgentRuntimeDisplay {
  kind: 'none' | 'running' | 'stopping' | 'retrying' | 'interrupted' | 'background' | 'delegation'
  /** 操作准入仍需 main 校验；这里用于保持现有活跃显示与按钮保护。 */
  active: boolean
  label: string
  showRunningIndicator: boolean
  showRetry: boolean
}

export function deriveAgentRuntimeDisplay(facts: AgentRuntimeDisplayFacts): AgentRuntimeDisplay {
  const rawCount = facts.runningDelegationCount ?? 0
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0
  const active = facts.running || facts.stopping === true || facts.backgroundWaiting === true || count > 0
  const display = (kind: AgentRuntimeDisplay['kind'], label = '', showRetry = false): AgentRuntimeDisplay => ({
    kind, active, label, showRunningIndicator: kind === 'running', showRetry,
  })

  if (facts.stopping) return display('stopping', '正在停止，等待运行结束确认')
  // 压缩期间由 CompactingIndicator 接管，不重复显示运行行；手动压缩 run 在 compact_boundary
  // 之后只剩合成 result，用 compactInFlight 把抑制延续到 run 结束避免闪烁。
  // 自动压缩（阈值/溢出）只置 isCompacting：压缩结束后同一轮会继续执行，必须立即恢复运行指示。
  if (facts.isCompacting || facts.compactInFlight) return display('none')
  if (facts.running) {
    if (facts.retrying && !facts.retryFailed) return display('retrying', '', true)
    const latestAssistant = facts.liveMessages?.findLast((message) => message.type === 'assistant')
    if (facts.streamError || latestAssistant?.error != null || facts.retryFailed) {
      return display('interrupted', '输出异常，运行尚未结束', facts.retrying === true)
    }
    return display('running')
  }
  if (facts.backgroundWaiting) {
    return display('background', count > 0
      ? `本轮已答复，后台任务和 ${count} 个协作子会话仍在执行`
      : '本轮已答复，后台任务仍在执行')
  }
  if (count > 0) return display('delegation', `本轮已答复，仍在等待 ${count} 个协作子会话`)
  return display('none')
}
