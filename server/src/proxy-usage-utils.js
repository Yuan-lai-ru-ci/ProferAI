/**
 * 代理用量解析工具
 *
 * 统一处理非流式响应和 SSE 流式响应中的 usage 字段，保证后台用量统计
 * 能拿到真实 token，而不是只看到预扣费用。
 */

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function normalizeAnthropicUsage(usage) {
  const regularInput = toNumber(usage?.input_tokens)
  const completionTokens = toNumber(usage?.output_tokens)
  const cacheCreationTokens = toNumber(usage?.cache_creation_input_tokens)
  const cacheReadTokens = toNumber(usage?.cache_read_input_tokens)
  const promptTokens = regularInput + cacheCreationTokens + cacheReadTokens

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheCreationTokens,
    cacheReadTokens,
  }
}

function normalizeOpenAIUsage(usage) {
  const promptTokens = toNumber(usage?.prompt_tokens)
  const completionTokens = toNumber(usage?.completion_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: toNumber(usage?.total_tokens, promptTokens + completionTokens),
    cacheCreationTokens: 0,
    cacheReadTokens: toNumber(usage?.prompt_tokens_details?.cached_tokens),
  }
}

export function extractUsage(data) {
  if (!data) return null

  const directUsage = data.usage
  if (directUsage?.input_tokens !== undefined || directUsage?.output_tokens !== undefined) return normalizeAnthropicUsage(directUsage)
  if (directUsage?.total_tokens !== undefined) return normalizeOpenAIUsage(directUsage)

  const messageUsage = data.message?.usage
  if (messageUsage?.input_tokens !== undefined) return normalizeAnthropicUsage(messageUsage)

  return null
}

export function extractModel(data, fallback) {
  return data?.model || data?.message?.model || fallback
}

export function withOpenAIStreamUsage(body, relayPath) {
  if (relayPath !== '/v1/chat/completions' || body?.stream !== true) return body
  return {
    ...body,
    stream_options: {
      ...(body.stream_options || {}),
      include_usage: true,
    },
  }
}

function mergeUsage(previous, next) {
  if (!previous) return next
  const promptTokens = next.promptTokens || previous.promptTokens
  const completionTokens = Math.max(previous.completionTokens || 0, next.completionTokens || 0)
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(previous.totalTokens || 0, next.totalTokens || 0, promptTokens + completionTokens),
    cacheCreationTokens: next.cacheCreationTokens || previous.cacheCreationTokens,
    cacheReadTokens: next.cacheReadTokens || previous.cacheReadTokens,
  }
}

export function createStreamUsageTracker(fallbackModel = 'unknown') {
  let buffer = ''
  let usage = null
  let model = fallbackModel

  function handleDataLine(dataLine) {
    const trimmed = dataLine.trim()
    if (!trimmed || trimmed === '[DONE]') return

    try {
      const payload = JSON.parse(trimmed)
      model = extractModel(payload, model)
      const nextUsage = extractUsage(payload)
      if (nextUsage) usage = mergeUsage(usage, nextUsage)
    } catch {
      // 忽略非 JSON 的 data 行，保持代理透传不中断。
    }
  }

  function handleLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('data: ')) {
      handleDataLine(line.slice(6))
    } else if (line.startsWith('data:')) {
      handleDataLine(line.slice(5))
    }
  }

  return {
    ingest(text) {
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) handleLine(line)
    },
    finish() {
      if (buffer) {
        handleLine(buffer)
        buffer = ''
      }
      return { model, usage }
    },
  }
}
