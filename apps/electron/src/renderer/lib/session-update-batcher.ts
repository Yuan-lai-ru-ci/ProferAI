export interface SessionUpdateBatcherOptions {
  schedule?: (callback: () => void) => number
  cancel?: (handle: number) => void
}

/**
 * 将同一帧内同一会话的高频更新合并为一次提交。
 * 每个 session 独立排队，批处理不会把一个会话的更新写到另一个会话。
 */
export function createSessionUpdateBatcher<T>(
  flush: (sessionId: string, updates: readonly T[]) => void,
  options: SessionUpdateBatcherOptions = {},
) {
  const pending = new Map<string, T[]>()
  const scheduled = new Map<string, number>()
  const schedule = options.schedule ?? ((callback: () => void) => {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
    return setTimeout(callback, 16) as unknown as number
  })
  const cancel = options.cancel ?? ((handle: number) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    else clearTimeout(handle)
  })

  const flushSession = (sessionId: string): void => {
    const handle = scheduled.get(sessionId)
    if (handle !== undefined) {
      cancel(handle)
      scheduled.delete(sessionId)
    }
    const updates = pending.get(sessionId)
    if (!updates || updates.length === 0) return
    pending.delete(sessionId)
    flush(sessionId, updates)
  }

  return {
    enqueue(sessionId: string, update: T): void {
      const updates = pending.get(sessionId) ?? []
      updates.push(update)
      pending.set(sessionId, updates)
      if (!scheduled.has(sessionId)) {
        scheduled.set(sessionId, schedule(() => flushSession(sessionId)))
      }
    },
    flush(sessionId: string): void {
      flushSession(sessionId)
    },
    flushAll(): void {
      for (const sessionId of pending.keys()) flushSession(sessionId)
    },
    cancel(sessionId: string): void {
      const handle = scheduled.get(sessionId)
      if (handle !== undefined) cancel(handle)
      scheduled.delete(sessionId)
      pending.delete(sessionId)
    },
  }
}
