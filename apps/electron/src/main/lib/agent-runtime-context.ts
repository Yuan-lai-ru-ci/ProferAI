export interface AgentRuntimeContextSnapshot {
  sessionId: string
  contextWindow: number
  updatedAt: number
}

/**
 * 活跃 Agent 会话的非持久化运行时上下文窗口。
 *
 * `context_window` 是启动时的瞬时事件；远程 Pocket 若在 run 已开始后连接会错过它。
 * 此存储仅保留活动 run，供重连快照恢复使用；会话结束立即释放，不能作为历史会话数据。
 */
export class AgentRuntimeContextStore {
  private readonly snapshots = new Map<string, AgentRuntimeContextSnapshot>()

  setContextWindow(sessionId: string, contextWindow: number, updatedAt = Date.now()): void {
    if (!sessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) return
    this.snapshots.set(sessionId, { sessionId, contextWindow, updatedAt })
  }

  clear(sessionId: string): void {
    this.snapshots.delete(sessionId)
  }

  list(sessionIds?: readonly string[]): AgentRuntimeContextSnapshot[] {
    if (!sessionIds) return Array.from(this.snapshots.values())
    const allowed = new Set(sessionIds)
    return Array.from(this.snapshots.values()).filter((snapshot) => allowed.has(snapshot.sessionId))
  }
}
