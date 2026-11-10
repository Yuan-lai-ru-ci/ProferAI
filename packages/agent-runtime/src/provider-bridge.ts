import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntime,
  AgentRuntimeCapabilities,
  SDKMessage,
} from '@profer/shared'
import type { AgentRuntimeAdapter, AgentRuntimeQuery } from './contract'
import type { AgentRunOutcome } from './events'

export interface AgentRuntimeProviderAdapterOptions {
  mapInput?: (input: AgentRuntimeQuery, base: AgentQueryInput & { prepared?: AgentRuntimeQuery['prepared'] }) => AgentQueryInput
  /**
   * 出口装饰器：provider 产出的每条消息在交给 runtime 之前过一遍。
   * 宿主用它把本轮受控写入挂到 `tool_result` 上（消息气泡里的文件改动 chip）。
   * 不返回新对象时保持原引用，避免下游按形状/引用比较的行为漂移。
   */
  mapMessage?: (message: SDKMessage, input: AgentRuntimeQuery) => SDKMessage
}

function toProviderInput(input: AgentRuntimeQuery): AgentQueryInput & { prepared?: AgentRuntimeQuery['prepared'] } {
  const providerInput = input.providerInput
  const extra = providerInput && typeof providerInput === 'object' ? providerInput as Readonly<Record<string, unknown>> : undefined
  return {
    ...(extra ?? {}),
    sessionId: input.sessionId,
    // 宿主在准备阶段拼好的本轮 prompt 优先：动态上下文依赖实际加载的 MCP 名单，
    // 构造 query 时拿不到。没有 prepared.prompt 时行为与之前完全一致。
    prompt: input.prepared?.prompt ?? input.prompt,
    ...(input.modelId ? { model: input.modelId } : {}),
    agentRuntime: input.runtime,
    ...(input.isolatedRuntimeSession !== undefined ? { isolatedRuntimeSession: input.isolatedRuntimeSession } : {}),
    ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.prepared ? { prepared: input.prepared } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 将 shared provider async iterable 适配为 runtime adapter。
 * provider 的进程、权限和 SDK 仍由宿主实现；runtime 只统一 stream/stop/dispose 边界。
 */
export function createAgentRuntimeProviderAdapter(
  runtime: AgentRuntime,
  provider: AgentProviderAdapter,
  options: AgentRuntimeProviderAdapterOptions = {},
): AgentRuntimeAdapter {
  const activeAttempts = new Map<string, { drained: Promise<void>; finish(): void }>()
  const adapter: AgentRuntimeAdapter = {
    runtime,
    stream(input: AgentRuntimeQuery): AsyncIterable<SDKMessage> {
      let finish!: () => void
      const drained = new Promise<void>(resolve => { finish = resolve })
      const attempt = { drained, finish }
      activeAttempts.set(input.sessionId, attempt)
      const base = toProviderInput(input)
      let source: AsyncIterable<SDKMessage>
      try { source = provider.query(options.mapInput?.(input, base) ?? base) }
      catch (error) {
        if (activeAttempts.get(input.sessionId) === attempt) activeAttempts.delete(input.sessionId)
        finish()
        throw error
      }
      const mapMessage = options.mapMessage
      return (async function* () {
        try {
          if (!mapMessage) {
            yield* source
            return
          }
          for await (const message of source) yield mapMessage(message, input)
        } finally {
          // 旧 attempt 的延迟清理不能移除同一 session 的新 attempt。
          if (activeAttempts.get(input.sessionId) === attempt) activeAttempts.delete(input.sessionId)
          finish()
        }
      })()
    },
    async query(input, callbacks): Promise<AgentRunOutcome> {
      try {
        const mapMessage = options.mapMessage
        for await (const message of provider.query(options.mapInput?.(input, toProviderInput(input)) ?? toProviderInput(input))) {
          await callbacks.onMessage?.(mapMessage ? mapMessage(message, input) : message)
        }
        return { status: 'completed' }
      } catch (error) {
        await callbacks.onError?.(error)
        return { status: 'failed', error: errorMessage(error) }
      }
    },
    waitForDrain(sessionId) {
      return activeAttempts.get(sessionId)?.drained ?? Promise.resolve()
    },
    stop(_reason, sessionId) {
      if (sessionId) {
        if (activeAttempts.has(sessionId)) provider.abort(sessionId)
        return
      }
      for (const activeSessionId of activeAttempts.keys()) provider.abort(activeSessionId)
    },
    dispose() {
      provider.dispose()
    },
    getCapabilities(): AgentRuntimeCapabilities {
      const capabilities = provider.getCapabilities?.() ?? {
        supportsTaskOutput: Boolean(provider.getTaskOutput),
        supportsTaskStop: Boolean(provider.stopTask),
        supportsRewind: runtime === 'claude',
        supportsInterrupt: Boolean(provider.interruptQuery),
        supportsQueuedMessage: Boolean(provider.sendQueuedMessage),
        supportsBackgroundWakeup: runtime === 'claude',
        supportsNativeMcp: runtime === 'claude',
        runtimeSupportsSubagents: true,
      }
      return { runtime, available: true, ...capabilities }
    },
  }
  return adapter
}

export type { AgentProviderAdapter }
