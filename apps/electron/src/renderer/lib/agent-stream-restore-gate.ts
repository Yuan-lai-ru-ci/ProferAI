/**
 * 刷新恢复窗口的终态闸门。
 *
 * renderer 大刷新后会调用 `restoreActiveAgentStreams()`：main 侧同步回放本轮 backlog，
 * 并按当前登记窗口补发终态 IPC；而 renderer 的 running 占位要等这次 IPC **返回之后**
 * 才在 `.then` 里写入。若本轮 run 恰好在这个窗口内结束，终态会先于占位到达，
 * 专用 handler 的竞态保护（`isCurrentAgentStreamCompletion` 要求 running/backgroundWaiting）
 * 会把它当作迟到终态丢弃，收尾副作用（通知、未查看标记、消息重载、finalize）全部丢失，
 * 极端情况下刷新后残留 spinner。
 *
 * 闸门把这段时间内到达的终态暂存起来，等占位写入后（`settle()`）按原顺序派发。
 * 已经存在流式状态的会话不暂存：那说明 backlog 或其他事件已经建立了状态，
 * 直接派发即可通过竞态保护，也能避免延迟用户可见的收尾动作。
 */
export class AgentStreamRestoreGate {
  private activeRestores = 0
  private readonly deferred: Array<() => void> = []

  constructor(private readonly hasStreamState: (sessionId: string) => boolean) {}

  /** 开始一次恢复请求；所有并发请求结束后才放行暂存的终态。 */
  begin(): () => void {
    this.activeRestores += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeRestores -= 1
      if (this.activeRestores === 0) this.flush()
    }
  }

  /**
   * 判断终态是否需要延后派发。
   *
   * @returns true 表示已暂存，调用方必须立刻返回、不要再执行终态处理。
   */
  defer(sessionId: string, dispatch: () => void): boolean {
    if (this.activeRestores === 0) return false
    if (this.hasStreamState(sessionId)) return false
    this.deferred.push(dispatch)
    return true
  }

  /** 所有恢复请求完成后放行暂存的终态。 */
  private flush(): void {
    const pending = this.deferred.splice(0)
    for (const dispatch of pending) dispatch()
  }

  /** 仅供测试与诊断：当前暂存数量。 */
  get pendingCount(): number {
    return this.deferred.length
  }
}

/** 旧版 IPC 只返回 sessionId 字符串，按活跃流兼容。 */
export function isActiveRestoreSnapshot(snapshot: string | { active: boolean }): boolean {
  return typeof snapshot === 'string' || snapshot.active === true
}

/** 已结束但仍会回放终态的快照需要一次性占位，让完成处理能执行并立即收敛。 */
export function shouldCreateRestoreState(snapshot: string | { active: boolean; hasTerminalEvent: boolean }): boolean {
  return isActiveRestoreSnapshot(snapshot) || (typeof snapshot !== 'string' && snapshot.hasTerminalEvent)
}
