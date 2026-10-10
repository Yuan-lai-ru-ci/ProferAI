export type GuardedBrowserAction = 'click' | 'submit' | 'delete' | 'purchase' | 'send'

export interface BrowserActionGuardKey {
  sessionId: string
  tabId: string
  ref: string
  action: GuardedBrowserAction
}

function keyOf(input: BrowserActionGuardKey): string {
  return `${input.sessionId}\u0000${input.tabId}\u0000${input.action}\u0000${input.ref}`
}

/**
 * 记录“已经派发、结果未知”的动作。
 *
 * 它只阻止同一 session/tab/ref/action 的隐式重复派发；新的 BrowserObserve 会
 * 显式清理该 tab 的记录，让调用方在看到最新页面后重新作出决定。状态按会话和
 * 标签隔离，不能污染其它会话或其它标签。
 */
export class BrowserActionGuard {
  private readonly uncertain = new Set<string>()

  isBlocked(input: BrowserActionGuardKey): boolean {
    return this.uncertain.has(keyOf(input))
  }

  markUncertain(input: BrowserActionGuardKey): void {
    this.uncertain.add(keyOf(input))
  }

  clearAction(input: BrowserActionGuardKey): void {
    this.uncertain.delete(keyOf(input))
  }

  clearTab(sessionId: string, tabId: string): void {
    const prefix = `${sessionId}\u0000${tabId}\u0000`
    for (const key of this.uncertain) {
      if (key.startsWith(prefix)) this.uncertain.delete(key)
    }
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of this.uncertain) {
      if (key.startsWith(prefix)) this.uncertain.delete(key)
    }
  }

  get size(): number {
    return this.uncertain.size
  }
}
