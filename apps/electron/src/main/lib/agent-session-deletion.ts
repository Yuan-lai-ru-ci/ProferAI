export type AgentSessionDeletionDependencies = {
  /** 返回叶子到根的删除顺序；默认仅删除请求的会话。 */
  getDeletionOrder?: (id: string) => string[]
  beginDeletion: (id: string) => void
  endDeletion: (id: string) => void
  stopAndWait: (id: string) => Promise<void>
  clearState: (id: string) => void
  deleteSession: (id: string) => void
}

/**
 * 合并同一根会话的并发删除。级联删除先锁定并停止整棵委派树，所有 stop-and-wait
 * 成功前绝不清理任何持久化数据；成功后才按叶子到根删除，防止遗留孤儿子会话。
 */
export class AgentSessionDeletionCoordinator {
  private inFlight = new Map<string, Promise<void>>()

  delete(id: string, deps: AgentSessionDeletionDependencies): Promise<void> {
    const requestedExisting = this.inFlight.get(id)
    if (requestedExisting) return requestedExisting

    const order = [...new Set(deps.getDeletionOrder?.(id) ?? [id])]
    // 防御实现方返回空数组，删除请求至少必须处理目标会话本身。
    if (order.length === 0) order.push(id)
    const lockedIds = [...new Set([...order, id])]
    // 若子会话正被自身或另一个父会话的级联删除，合并到已有事务，防止双重清理。
    for (const sessionId of lockedIds) {
      const existing = this.inFlight.get(sessionId)
      if (existing) return existing
    }

    const deletion = (async () => {
      for (const sessionId of lockedIds) deps.beginDeletion(sessionId)
      try {
        // 先停止整棵树。任一个超时/失败时，不会进入下面的清理和删除阶段。
        for (const sessionId of lockedIds) await deps.stopAndWait(sessionId)
        for (const sessionId of order) {
          deps.clearState(sessionId)
          deps.deleteSession(sessionId)
        }
      } finally {
        for (const sessionId of lockedIds) deps.endDeletion(sessionId)
      }
    })()
    for (const sessionId of lockedIds) this.inFlight.set(sessionId, deletion)
    deletion.finally(() => {
      for (const sessionId of lockedIds) {
        if (this.inFlight.get(sessionId) === deletion) this.inFlight.delete(sessionId)
      }
    }).catch(() => {})
    return deletion
  }
}
