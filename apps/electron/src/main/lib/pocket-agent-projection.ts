import { projectMessageProvenance } from '@profer/shared'
import type { AgentStreamPayload, SDKMessage } from '@profer/shared'

/** 只保留上下文用量需要的四个 token 计数，避免把完整 usage 形状带进 WS。 */
function projectUsageForPocket(usage: Record<string, unknown>): Record<string, number> {
  const projected: Record<string, number> = {}
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (typeof usage[key] === 'number') projected[key] = usage[key] as number
  }
  return projected
}

/**
 * 思考正文在移动端的体积上限。
 *
 * Pi 的 partial 帧是「累计全文」：每个 60ms 合并窗口都会重发一遍当前思考。
 * 移动端只需要看到「还在想」以及最近的推理走向，因此 partial 只带尾部窗口，
 * final 放宽到 [THINKING_MAX_CHARS]；超长思考保留结尾（结论通常在这里）。
 */
const THINKING_PARTIAL_TAIL_CHARS = 800
const THINKING_MAX_CHARS = 2000

function projectThinkingForPocket(text: unknown, partial: boolean): Record<string, unknown> | null {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (!value) return null
  const limit = partial ? THINKING_PARTIAL_TAIL_CHARS : THINKING_MAX_CHARS
  if (value.length <= limit) return { type: 'thinking', thinking: value }
  return { type: 'thinking', thinking: `…${value.slice(-limit)}` }
}

/**
 * 移动端只接收图片引用（路径 + 文件名 + MIME），字节按需用 `read_file_as_data_url` 拉取。
 * 工具结果里的图片（send_local_image / generate_image 的结构化 details）不走 base64 通道，
 * 否则每帧重发图片会撑爆 WebSocket 与重放日志。
 */
const POCKET_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const POCKET_IMAGE_LIMIT = 4

type PocketImageRef = { path: string; filename: string; mediaType: string }

function collectPocketImageRefs(
  value: unknown,
  found: PocketImageRef[] = [],
  depth = 0,
  seen = new Set<object>(),
): PocketImageRef[] {
  if (!value || typeof value !== 'object' || depth > 4 || found.length >= POCKET_IMAGE_LIMIT) return found
  const record = value as Record<string, unknown>
  if (seen.has(record)) return found
  seen.add(record)

  const candidates: unknown[] = []
  if (record.image !== undefined) candidates.push(record.image)
  if (Array.isArray(record.imageAttachments)) candidates.push(...record.imageAttachments)
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const image = candidate as Record<string, unknown>
    const path = typeof image.localPath === 'string' ? image.localPath.trim() : ''
    const filename = typeof image.filename === 'string' ? image.filename.trim() : ''
    const mediaType = typeof image.mediaType === 'string' ? image.mediaType : ''
    if (!path || !filename || !POCKET_IMAGE_MEDIA_TYPES.has(mediaType)) continue
    if (found.some((item) => item.path === path)) continue
    found.push({ path, filename, mediaType })
    if (found.length >= POCKET_IMAGE_LIMIT) break
  }

  // Claude MCP 把 details 包在 structuredContent 里，Pi 直接放在顶层。
  for (const key of ['output', 'details', 'structuredContent']) collectPocketImageRefs(record[key], found, depth + 1, seen)
  return found
}

/**
 * Pocket 只需要渲染正文、工具活动摘要和有界的思考预览，不需要工具入参/结果或 SDK 内部字段。
 * 该投影在远程出口使用，避免完整 SDK 消息进入 WebSocket、重放日志和移动端缓存。
 */
export function projectSdkMessageForPocket(message: SDKMessage): SDKMessage {
  const record = message as Record<string, unknown>
  const base: Record<string, unknown> = { type: message.type }
  for (const key of ['uuid', 'session_id', 'parent_tool_use_id', '_createdAt', '_partial', '_channelModelId', 'isReplay', 'isSynthetic', '_goalIteration']) {
    if (record[key] !== undefined) base[key] = record[key]
  }
  const provenance = projectMessageProvenance(record._provenance)
  if (provenance) base._provenance = provenance

  if (message.type === 'assistant') {
    const inner = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : {}
    const content = Array.isArray(inner.content) ? inner.content : []
    // 思考可能分散在多个块里（思考 → 工具 → 再思考），合并后统一截断，避免多块各自占用额度。
    const thinkingText = content.reduce((acc: string, block): string => {
      if (!block || typeof block !== 'object') return acc
      const item = block as Record<string, unknown>
      return item.type === 'thinking' && typeof item.thinking === 'string' ? acc + item.thinking : acc
    }, '')
    const thinkingBlock = projectThinkingForPocket(thinkingText, record._partial === true)
    const projectedContent = content.flatMap((block): Array<Record<string, unknown>> => {
      if (!block || typeof block !== 'object') return []
      const item = block as Record<string, unknown>
      if (item.type === 'thinking') return []
      if (item.type === 'text' && typeof item.text === 'string') return [{ type: 'text', text: item.text }]
      if (item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string') {
        // 入参只透传文件路径：移动端需要在正文/回合末尾渲染文件 chip，
        // 但不应该把完整工具参数（命令、补丁、搜索结果）带进 WebSocket。
        const input = item.input && typeof item.input === 'object' ? item.input as Record<string, unknown> : {}
        const filePath = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
        return [{
          type: 'tool_use',
          id: item.id,
          name: item.name,
          input: typeof filePath === 'string' ? { file_path: filePath } : {},
        }]
      }
      return []
    })
    base.message = {
      role: typeof inner.role === 'string' ? inner.role : 'assistant',
      content: thinkingBlock ? [thinkingBlock, ...projectedContent] : projectedContent,
      ...(typeof inner.model === 'string' ? { model: inner.model } : {}),
      ...(inner.stop_reason !== undefined ? { stop_reason: inner.stop_reason } : {}),
      // 上下文用量：移动端用 assistant 消息的 usage 计算「已用 / 窗口」，
      // 不能用 result.usage（整轮累计求和，会虚高）。只透传四个 token 数字。
      ...(inner.usage && typeof inner.usage === 'object' ? { usage: projectUsageForPocket(inner.usage as Record<string, unknown>) } : {}),
    }
    if (record.error && typeof record.error === 'object') base.error = record.error
    return base as SDKMessage
  }

  if (message.type === 'user') {
    const inner = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : {}
    const content = Array.isArray(inner.content) ? inner.content : []
    // 图片附件挂在工具结果消息的顶层 `tool_use_result` 上，移动端按 tool_result 块绑定渲染。
    const imageRefs = collectPocketImageRefs(record.tool_use_result ?? record.toolUseResult)
    const projectedContent = content.flatMap((block): Array<Record<string, unknown>> => {
      if (!block || typeof block !== 'object') return []
      const item = block as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') return [{ type: 'text', text: item.text }]
      if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        return [{
          type: 'tool_result',
          tool_use_id: item.tool_use_id,
          ...(item.is_error === true ? { is_error: true } : {}),
          ...(imageRefs.length > 0 ? { images: imageRefs } : {}),
        }]
      }
      return []
    })
    base.message = { content: projectedContent }
    return base as SDKMessage
  }

  if (message.type === 'result') {
    for (const key of ['subtype', 'total_cost_usd', 'terminal_reason', '_durationMs', '_channelModelId']) {
      if (record[key] !== undefined) base[key] = record[key]
    }
    if (record.usage && typeof record.usage === 'object') {
      const usage = record.usage as Record<string, unknown>
      base.usage = {
        ...(typeof usage.input_tokens === 'number' ? { input_tokens: usage.input_tokens } : {}),
        ...(typeof usage.output_tokens === 'number' ? { output_tokens: usage.output_tokens } : {}),
        ...(typeof usage.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(typeof usage.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
      }
    }
    if (record.modelUsage && typeof record.modelUsage === 'object') {
      const modelUsage: Record<string, unknown> = {}
      for (const [model, value] of Object.entries(record.modelUsage as Record<string, unknown>)) {
        if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).contextWindow === 'number') {
          modelUsage[model] = { contextWindow: (value as Record<string, unknown>).contextWindow }
        }
      }
      if (Object.keys(modelUsage).length > 0) base.modelUsage = modelUsage
    }
    return base as SDKMessage
  }

  if (message.type === 'system') {
    if (record.subtype === 'task_trigger') {
      // 来源通知只带可读说明；不继承其他 system 工具/路径/授权字段。
      base.subtype = 'task_trigger'
      if (typeof record.message === 'string') base.message = record.message
      return base as SDKMessage
    }
    for (const key of ['subtype', 'model', 'task_id', 'description', 'task_type', 'tool_use_id', 'status', 'summary', 'output_file', 'last_tool_name', 'tool_name', 'message', 'decision_reason', 'estimated_tokens', 'estimated_tokens_delta', 'usage']) {
      if (record[key] !== undefined) base[key] = record[key]
    }
    return base as SDKMessage
  }

  for (const key of ['tool_use_id', 'task_id', 'elapsed_time_seconds', 'summary', 'preceding_tool_use_ids']) {
    if (record[key] !== undefined) base[key] = record[key]
  }
  return base as SDKMessage
}

export interface PocketAgentViewMessage {
  id: string
  role: 'user' | 'assistant' | 'status'
  content: string
  createdAt: number
  model?: string
  subtype?: 'task_trigger'
  _provenance?: SDKMessage['_provenance']
}

/** 详情视图与实时/分页消息共用白名单，system 来源通知保留为可读 status。 */
export function projectSdkMessagesToPocketView(messages: readonly SDKMessage[]): PocketAgentViewMessage[] {
  return messages.flatMap((message): PocketAgentViewMessage[] => {
    const projected = projectSdkMessageForPocket(message)
    const record = projected as Record<string, unknown>
    const inner = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : undefined
    const isTrigger = projected.type === 'system' && record.subtype === 'task_trigger'
    const role = isTrigger ? 'status' : projected.type === 'user' || projected.type === 'assistant' ? projected.type : undefined
    if (!role) return []
    const content = isTrigger
      ? typeof record.message === 'string' ? record.message : '任务来源'
      : Array.isArray(inner?.content)
        ? inner.content.flatMap((block): string[] => {
          if (!block || typeof block !== 'object') return []
          const item = block as Record<string, unknown>
          return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
        }).join('')
        : ''
    if (role === 'user' && !content.trim()) return []
    return [{
      id: typeof record.uuid === 'string' ? record.uuid : projected._provenance?.messageId ?? `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role,
      content,
      createdAt: typeof record._createdAt === 'number' ? record._createdAt : Date.now(),
      ...(typeof inner?.model === 'string' ? { model: inner.model } : {}),
      ...(isTrigger ? { subtype: 'task_trigger' as const } : {}),
      ...(projected._provenance ? { _provenance: projected._provenance } : {}),
    }]
  })
}

export function projectAgentPayloadForPocket(payload: AgentStreamPayload): AgentStreamPayload {
  if (payload.kind !== 'sdk_message') return payload
  return { kind: 'sdk_message', message: projectSdkMessageForPocket(payload.message) }
}
