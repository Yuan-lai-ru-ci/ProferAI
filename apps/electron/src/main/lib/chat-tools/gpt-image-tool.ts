/**
 * GPT Image 工具（仅 Chat 模式）。
 *
 * 默认走 Profer 官方代管服务：固定 gpt-image-2，成功单张扣 5 积分。
 * 用户也可切换到 BYOK；两条路径都正确区分 generations(JSON) 与 edits(multipart)。
 */
import type { ToolCall, ToolResult, ToolDefinition } from '@profer/core'
import type { ChatToolMeta, FileAttachment } from '@profer/shared'
import { randomUUID } from 'node:crypto'
import { getGptImageCredentials } from '../chat-tool-config'
import { getTeamAuth, getTeamAuthWithRefresh } from '../auth-service'
import {
  saveAttachment,
  readAttachmentAsBase64,
  isImageAttachment,
} from '../attachment-service'

interface GptImageResponse {
  created?: number
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  error?: { message?: string; code?: string; type?: string }
}

interface ImageReference {
  data: string
  mediaType: string
  filename: string
}

export interface GptImageContext {
  conversationId: string
  currentAttachments?: FileAttachment[]
  previousUserAttachments?: FileAttachment[]
  previousAssistantAttachments?: FileAttachment[]
}

const DEFAULT_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL = 'gpt-image-2'
const VALID_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto'])
const VALID_QUALITIES = new Set(['auto', 'low', 'medium', 'high'])

export const GPT_IMAGE_TOOL_META: ChatToolMeta = {
  id: 'gpt-image',
  name: 'GPT Image',
  description: 'AI 图片生成与参考图编辑（官方模式每张成功扣 5 积分）',
  params: [
    {
      name: 'prompt',
      type: 'string',
      description: '图片生成/编辑描述',
      required: true,
    },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<gpt_image_instructions>
你拥有 AI 图片生成与参考图编辑能力（GPT Image）。
当用户要求生成、绘制、创作图片，或上传图片后要求修改时，调用 generate_image。
- prompt：详细描述生成内容或编辑要求。
- size：可选 "1024x1024" / "1536x1024" / "1024x1536" / "auto"。
- quality：可选 "auto" / "low" / "medium" / "high"。
- useReferenceImages：用户上传参考图或要求修改之前生成的图片时设为 "true"。
每次调用仅生成或编辑 1 张图片；Profer 官方模式仅在成功后扣 5 积分，失败不扣费。
</gpt_image_instructions>`,
}

export const GPT_IMAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'generate_image',
    description:
      'Generate one image or edit uploaded reference images. Official mode charges 5 Profer credits only after successful delivery.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed image generation or editing instruction.',
        },
        size: {
          type: 'string',
          description: 'Image size',
          enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
        },
        quality: {
          type: 'string',
          description: 'Image quality',
          enum: ['auto', 'low', 'medium', 'high'],
        },
        useReferenceImages: {
          type: 'string',
          description: 'Set true to edit attached reference images',
          enum: ['true', 'false'],
        },
      },
      required: ['prompt'],
    },
  },
]

/** 官方模式必须存在当前团队登录；BYOK 只要求主进程可解密 Key。 */
export function isGptImageAvailable(): boolean {
  const credentials = getGptImageCredentials()
  return credentials.mode === 'official'
    ? !!getTeamAuth()
    : !!credentials.apiKey
}

const GPT_IMAGE_TOOL_NAMES = new Set(['generate_image'])
export function isGptImageToolCall(toolName: string): boolean {
  return GPT_IMAGE_TOOL_NAMES.has(toolName)
}

function normalizeBaseUrl(value: string): string {
  return (value.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function collectReferenceImages(context: GptImageContext): ImageReference[] {
  const images: ImageReference[] = []
  const attachments = [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]
  for (const attachment of attachments) {
    if (!isImageAttachment(attachment.mediaType)) continue
    try {
      images.push({
        data: readAttachmentAsBase64(attachment.localPath),
        mediaType: attachment.mediaType,
        filename: attachment.filename || 'reference-image',
      })
    } catch (error) {
      console.warn(`[GPT Image] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }
  return images
}

async function resolveImageBase64(
  item: NonNullable<GptImageResponse['data']>[number],
  apiKey?: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (item.b64_json) {
    const data = item.b64_json
      .replace(/^data:image\/[-\w+.]+;base64,/, '')
      .trim()
    return data ? { data, mimeType: 'image/png' } : null
  }
  if (!item.url) return null
  try {
    const response = await fetch(
      item.url,
      apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
    )
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      data: buffer.toString('base64'),
      mimeType: response.headers.get('content-type') || 'image/png',
    }
  } catch {
    return null
  }
}

function errorResult(toolCallId: string, content: string): ToolResult {
  return { toolCallId, content, isError: true }
}

async function parseImageResponse(
  response: Response,
  toolCallId: string,
  downloadKey?: string,
): Promise<ToolResult | GptImageResponse> {
  const text = await response.text()
  let data: GptImageResponse | null = null
  try {
    data = JSON.parse(text) as GptImageResponse
  } catch {
    /* handled below */
  }
  if (!response.ok) {
    const message =
      data?.error?.message ||
      (data as { error?: string } | null)?.error ||
      text.slice(0, 200) ||
      `HTTP ${response.status}`
    const code = data?.error?.code || (data as { code?: string } | null)?.code
    const friendly =
      code === 'INSUFFICIENT_CREDITS'
        ? '积分不足：官方生图每次成功需要 5 积分，请充值后重试。'
        : code === 'OFFICIAL_IMAGE_UNAVAILABLE'
          ? '官方图片服务暂不可用，请稍后重试或切换自带 Key。'
          : `图片生成失败 (${response.status})：${message}`
    return errorResult(toolCallId, friendly)
  }
  if (!data?.data?.length)
    return errorResult(toolCallId, '图片服务未返回有效图片，本次不会扣积分。')
  // 标记用于后续保存；不把 Base64 输出写入工具文字。
  Object.defineProperty(data, '__downloadKey', {
    value: downloadKey,
    enumerable: false,
  })
  return data
}

async function callOfficialImage({
  prompt,
  size,
  quality,
  references,
  idempotencyKey,
}: {
  prompt: string
  size: string
  quality: string
  references: ImageReference[]
  idempotencyKey: string
}): Promise<Response | null> {
  const auth = await getTeamAuthWithRefresh()
  if (!auth) return null
  const baseUrl = auth.baseUrl.replace(/\/+$/, '')
  const endpoint = references.length
    ? '/v1/proxy/images/edits'
    : '/v1/proxy/images/generations'
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.proxyToken || auth.token}`,
    // 同一 tool call 重试必须复用此值，避免弱网/重放触发二次上游调用或二次扣费。
    'Idempotency-Key': idempotencyKey,
  }
  if (!references.length) {
    headers['Content-Type'] = 'application/json'
    return fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt,
        size,
        quality,
        n: 1,
      }),
    })
  }
  const form = new FormData()
  form.set('model', DEFAULT_MODEL)
  form.set('prompt', prompt)
  form.set('size', size)
  form.set('quality', quality)
  form.set('n', '1')
  for (const reference of references.slice(0, 4)) {
    form.append(
      'image[]',
      new Blob([Buffer.from(reference.data, 'base64')], {
        type: reference.mediaType,
      }),
      reference.filename,
    )
  }
  return fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: form,
  })
}

async function callByokImage({
  apiKey,
  baseUrl,
  model,
  prompt,
  size,
  quality,
  references,
}: {
  apiKey: string
  baseUrl: string
  model: string
  prompt: string
  size: string
  quality: string
  references: ImageReference[]
}): Promise<Response> {
  if (!references.length) {
    return fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        size,
        quality,
        n: 1,
        response_format: 'b64_json',
      }),
    })
  }
  const form = new FormData()
  form.set('model', model)
  form.set('prompt', prompt)
  form.set('size', size)
  form.set('quality', quality)
  form.set('n', '1')
  form.set('response_format', 'b64_json')
  for (const reference of references.slice(0, 4)) {
    form.append(
      'image[]',
      new Blob([Buffer.from(reference.data, 'base64')], {
        type: reference.mediaType,
      }),
      reference.filename,
    )
  }
  return fetch(`${baseUrl}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
}

export async function executeGptImageTool(
  toolCall: ToolCall,
  context: GptImageContext,
): Promise<ToolResult> {
  const prompt =
    typeof toolCall.arguments.prompt === 'string'
      ? toolCall.arguments.prompt.trim()
      : ''
  if (!prompt) return errorResult(toolCall.id, '参数缺失：prompt')
  const rawSize =
    typeof toolCall.arguments.size === 'string'
      ? toolCall.arguments.size
      : 'auto'
  const rawQuality =
    typeof toolCall.arguments.quality === 'string'
      ? toolCall.arguments.quality
      : 'auto'
  const size = VALID_SIZES.has(rawSize) ? rawSize : 'auto'
  const quality = VALID_QUALITIES.has(rawQuality) ? rawQuality : 'auto'
  const useReferenceImages = toolCall.arguments.useReferenceImages === 'true'
  const references = useReferenceImages ? collectReferenceImages(context) : []
  const credentials = getGptImageCredentials()

  try {
    let response: Response | null
    let downloadKey: string | undefined
    if (credentials.mode === 'official') {
      response = await callOfficialImage({
        prompt,
        size,
        quality,
        references,
        idempotencyKey: `gpt-image:${toolCall.id}`,
      })
      if (!response)
        return errorResult(toolCall.id, '官方生图需要先登录 Profer 团队账号。')
    } else {
      if (!credentials.apiKey)
        return errorResult(
          toolCall.id,
          '请先在“自带 OpenAI Key”模式填写 API Key。',
        )
      downloadKey = credentials.apiKey
      response = await callByokImage({
        apiKey: credentials.apiKey,
        baseUrl: normalizeBaseUrl(credentials.baseUrl),
        model: credentials.model.trim() || DEFAULT_MODEL,
        prompt,
        size,
        quality,
        references,
      })
    }
    const parsed = await parseImageResponse(response, toolCall.id, downloadKey)
    if ('toolCallId' in parsed) return parsed

    const attachments: FileAttachment[] = []
    const revisedPrompts: string[] = []
    for (const item of parsed.data ?? []) {
      const image = await resolveImageBase64(item, downloadKey)
      if (!image) continue
      const ext = image.mimeType.includes('jpeg')
        ? '.jpg'
        : image.mimeType.includes('webp')
          ? '.webp'
          : '.png'
      const saved = saveAttachment({
        conversationId: context.conversationId,
        filename: `gpt-image-${randomUUID().slice(0, 8)}${ext}`,
        mediaType: image.mimeType,
        data: image.data,
      })
      attachments.push(saved.attachment)
      if (item.revised_prompt) revisedPrompts.push(item.revised_prompt)
    }
    if (!attachments.length)
      return errorResult(
        toolCall.id,
        '图片生成结果无法保存，本次不会报告为成功。',
      )
    const chargeHint = credentials.mode === 'official' ? '，已扣 5 积分' : ''
    return {
      toolCallId: toolCall.id,
      content: `图片已成功${references.length ? '编辑' : '生成'}（1 张）${chargeHint}${revisedPrompts.length ? `\n\n修订后的提示词：\n${revisedPrompts.join('\n')}` : ''}`,
      generatedAttachments: attachments,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[GPT Image] 执行失败:', error)
    return errorResult(toolCall.id, `图片生成失败：${message}`)
  }
}

export function clearGptImageHistory(_conversationId: string): void {
  // 附件随对话删除走 attachment-service 的既有生命周期；无需额外状态。
}
