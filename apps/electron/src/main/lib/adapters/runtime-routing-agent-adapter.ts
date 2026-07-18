import {
  normalizeAgentRuntime,
  type AgentProviderAdapter,
  type AgentQueryInput,
  type AgentRuntime,
  type SDKMessage,
  type SDKUserMessageInput,
} from '@profer/shared'

/** 尚未注册 runtime 时返回明确错误，不能回退到 Claude 并执行错误的会话。 */
function unavailableRuntimeError(runtime: AgentRuntime): Error {
  return new Error(`${runtime === 'pi' ? 'Pi' : runtime} Agent runtime 当前不可用：执行适配器尚未接入。`)
}

/**
 * 按会话路由 Provider adapter。停止、队列和权限变更都使用 query 时固定的 runtime，
 * 避免运行中设置变化导致 P0 stop-and-wait 中止错误的底层进程。
 */
export class RuntimeRoutingAgentAdapter implements AgentProviderAdapter {
  private readonly sessionRuntimes = new Map<string, AgentRuntime>()

  constructor(private readonly adapters: Partial<Record<AgentRuntime, AgentProviderAdapter>>) {}

  get errorHelpers() {
    return this.requireAdapter('claude').errorHelpers
  }

  isAnthropicProxyProvider(provider: string): boolean {
    return this.requireAdapter('claude').isAnthropicProxyProvider?.(provider) ?? true
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const runtime = normalizeAgentRuntime(input.agentRuntime)
    const adapter = this.adapters[runtime]
    if (!adapter) throw unavailableRuntimeError(runtime)

    this.sessionRuntimes.set(input.sessionId, runtime)
    try {
      yield* adapter.query({ ...input, agentRuntime: runtime })
    } finally {
      // 不删除已被后续运行替换的绑定；stop-and-wait 仍可精确路由到最新 query。
      if (this.sessionRuntimes.get(input.sessionId) === runtime) {
        this.sessionRuntimes.delete(input.sessionId)
      }
    }
  }

  abort(sessionId: string): void {
    const runtime = this.sessionRuntimes.get(sessionId)
    if (runtime) {
      this.adapters[runtime]?.abort(sessionId)
      return
    }
    // 未开始 query 的异常路径只广播到已注册 adapter，保证清理不遗漏。
    for (const adapter of Object.values(this.adapters)) adapter?.abort(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    await this.getSessionAdapter(sessionId)?.interruptQuery?.(sessionId)
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const adapter = this.getSessionAdapter(sessionId)
    if (!adapter?.sendQueuedMessage) throw new Error('当前 Agent runtime 不支持追加消息')
    await adapter.sendQueuedMessage(sessionId, message)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    await this.getSessionAdapter(sessionId)?.cancelQueuedMessage?.(sessionId, messageUuid)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    await this.getSessionAdapter(sessionId)?.setPermissionMode?.(sessionId, mode)
  }

  dispose(): void {
    for (const adapter of Object.values(this.adapters)) adapter?.dispose()
    this.sessionRuntimes.clear()
  }

  private getSessionAdapter(sessionId: string): AgentProviderAdapter | undefined {
    return this.adapters[this.sessionRuntimes.get(sessionId) ?? 'claude']
  }

  private requireAdapter(runtime: AgentRuntime): AgentProviderAdapter {
    const adapter = this.adapters[runtime]
    if (!adapter) throw unavailableRuntimeError(runtime)
    return adapter
  }

}
