import {
  normalizeAgentRuntime,
  type AgentErrorHelpers,
  type AgentProviderAdapter,
  type AgentQueryInput,
  type AgentRuntime,
  type SDKMessage,
  type SDKUserMessageInput,
  type SendQueuedMessageOptions,
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
  /**
   * 活跃 query 的 runtime 绑定。token 用于防止同一 runtime 的旧 query finally
   * 在新 query 已开始后误删新绑定。
   */
  private readonly sessionRuntimes = new Map<string, { runtime: AgentRuntime; token: symbol }>()

  constructor(private readonly adapters: Partial<Record<AgentRuntime, AgentProviderAdapter>>) {}

  /**
   * 兼容没有 runtime 上下文的旧调用方；编排器在请求路径必须调用
   * getErrorHelpers(runtime)，避免把 Pi 错误按 Claude 规则映射。
   */
  get errorHelpers(): AgentErrorHelpers {
    return this.requireAdapter('claude').errorHelpers
  }

  getErrorHelpers(runtime: AgentRuntime): AgentErrorHelpers {
    return this.requireAdapter(runtime).errorHelpers
  }

  isAnthropicProxyProvider(provider: string): boolean {
    return this.requireAdapter('claude').isAnthropicProxyProvider?.(provider) ?? true
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const runtime = normalizeAgentRuntime(input.agentRuntime)
    const adapter = this.adapters[runtime]
    if (!adapter) throw unavailableRuntimeError(runtime)

    const token = Symbol(`agent-query:${input.sessionId}`)
    this.sessionRuntimes.set(input.sessionId, { runtime, token })
    try {
      yield* adapter.query({ ...input, agentRuntime: runtime })
    } finally {
      // 不删除已被后续运行替换的绑定；stop-and-wait 仍可精确路由到最新 query。
      if (this.sessionRuntimes.get(input.sessionId)?.token === token) {
        this.sessionRuntimes.delete(input.sessionId)
      }
    }
  }

  abort(sessionId: string): void {
    const binding = this.sessionRuntimes.get(sessionId)
    if (binding) {
      this.adapters[binding.runtime]?.abort(sessionId)
      return
    }
    // 未开始 query 的异常路径只广播到已注册 adapter，保证清理不遗漏。
    for (const adapter of Object.values(this.adapters)) adapter?.abort(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    await this.getSessionAdapter(sessionId)?.interruptQuery?.(sessionId)
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const adapter = this.getSessionAdapter(sessionId)
    if (!adapter?.sendQueuedMessage) throw new Error('当前活跃 Agent runtime 不支持追加消息')
    await adapter.sendQueuedMessage(sessionId, message, options)
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
    const runtime = this.sessionRuntimes.get(sessionId)?.runtime
    return runtime ? this.adapters[runtime] : undefined
  }

  private requireAdapter(runtime: AgentRuntime): AgentProviderAdapter {
    const adapter = this.adapters[runtime]
    if (!adapter) throw unavailableRuntimeError(runtime)
    return adapter
  }

}
