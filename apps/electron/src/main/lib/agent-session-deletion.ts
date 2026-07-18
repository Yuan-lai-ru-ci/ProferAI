export type AgentSessionDeletionDependencies = {
  beginDeletion: (id: string) => void
  endDeletion: (id: string) => void
  stopAndWait: (id: string) => Promise<void>
  clearState: (id: string) => void
  deleteSession: (id: string) => void
}

/**
 * 合并同一 session 的并发删除，并保证 stop-and-wait 成功前绝不清理持久化数据。
 */
export class AgentSessionDeletionCoordinator {
  private inFlight = new Map<string, Promise<void>>()

  delete(id: string, deps: AgentSessionDeletionDependencies): Promise<void> {
    const existing = this.inFlight.get(id)
    if (existing) return existing

    const deletion = (async () => {
      deps.beginDeletion(id)
      try {
        await deps.stopAndWait(id)
        deps.clearState(id)
        deps.deleteSession(id)
      } finally {
        deps.endDeletion(id)
      }
    })()
    this.inFlight.set(id, deletion)
    deletion.finally(() => {
      if (this.inFlight.get(id) === deletion) this.inFlight.delete(id)
    }).catch(() => {})
    return deletion
  }
}
