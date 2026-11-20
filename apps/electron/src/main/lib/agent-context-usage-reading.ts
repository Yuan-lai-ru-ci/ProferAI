import { inferContextWindow, resolveContextWindowFromModelUsage, type AgentContextUsageSnapshot, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage } from '@profer/shared'

type SdkUsage = NonNullable<SDKAssistantMessage['message']['usage']>

function fromUsage(usage: SdkUsage | undefined, model: string | undefined, contextWindow: number | undefined, usageUpdatedAt: number): AgentContextUsageSnapshot | undefined {
  if (!usage) return
  const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = usage
  if (![input_tokens, cache_read_input_tokens ?? 0, cache_creation_input_tokens ?? 0, output_tokens ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) return
  const inputTokens = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)
  if (!Number.isSafeInteger(inputTokens) || inputTokens === 0) return
  return { inputTokens, cacheReadTokens: cache_read_input_tokens, cacheCreationTokens: cache_creation_input_tokens, outputTokens: output_tokens, model, contextWindow, usageUpdatedAt }
}

/** 只保存本次主模型调用的读数。result 通常是整个 query 的累计量，只用它校准分母。 */
export function nextContextUsageReading(
  previous: AgentContextUsageSnapshot | undefined,
  message: SDKMessage,
  runtimeWindow: number | undefined,
  now: number,
): AgentContextUsageSnapshot | undefined {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const m = message as { compact_metadata?: { post_tokens?: number }; parent_tool_use_id?: string; isReplay?: boolean }
    const post = m.compact_metadata?.post_tokens
    if (!m.isReplay && !m.parent_tool_use_id && post != null && Number.isSafeInteger(post) && post > 0) {
      return { inputTokens: post, contextWindow: runtimeWindow, usageUpdatedAt: now }
    }
    return
  }
  if (message.type === 'assistant') {
    const m = message as SDKAssistantMessage
    if (m.parent_tool_use_id || m.isReplay || m.error) return
    const model = m._channelModelId ?? m.message?.model
    return fromUsage(m.message?.usage, model, runtimeWindow ?? inferContextWindow(model), now)
  }
  if (message.type !== 'result') return
  const m = message as SDKResultMessage & { num_turns?: number; parent_tool_use_id?: string; isReplay?: boolean }
  if (m.parent_tool_use_id || m.isReplay) return
  const model = m._channelModelId ?? previous?.model
  const window = resolveContextWindowFromModelUsage(m.modelUsage, model) ?? runtimeWindow
  if (previous) {
    if (window && window !== previous.contextWindow) return { ...previous, contextWindow: window }
    return
  }
  // 兼容仅返回 result 的渠道；无法证明这是一轮单次调用时不把总额当用量。
  if (m.num_turns === 1 && Object.keys(m.modelUsage ?? {}).length <= 1) {
    return fromUsage(m.usage, model, window ?? inferContextWindow(model), now)
  }
}
