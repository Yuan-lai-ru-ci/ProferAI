/**
 * GPT Image 生图工具模块（Chat 模式）
 *
 * 基于 OpenAI GPT Image API 提供 AI 生图能力。
 * 支持文生图、参考图编辑、多轮连续修改。
 * 凭据存储在 ~/.proma/chat-tools.json 的 toolCredentials 中。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@profer/core'
import type { ChatToolMeta, FileAttachment } from '@profer/shared'
import { randomUUID } from 'node:crypto'
import { getToolCredentials } from '../chat-tool-config'
import { saveAttachment, readAttachmentAsBase64, isImageAttachment } from '../attachment-service'

// ===== OpenAI GPT Image API 类型 =====

interface GptImageResponse {
  created?: number
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
  }>
  error?: { message: string; code: string; type: string }
}

/**
 * 从 GPT Image API 响应条目中提取图片 base64 数据
 *
 * 优先使用 b64_json（直接返回 base64），
 * 否则从 url 下载图片并转为 base64。
 */
async function resolveImageBase64(
  item: NonNullable<GptImageResponse['data']>[number],
  apiKey: string,
): Promise<{ data: string; mimeType: string } | null> {
  // 优先使用 b64_json
  if (item.b64_json) {
    // 去除可能的数据 URL 前缀（如 data:image/png;base64,）
    const raw = item.b64_json.replace(/^data:image\/\w+;base64,/, '')
    return { data: raw, mimeType: 'image/png' }
  }

  // 从 URL 下载
  if (item.url) {
    try {
      const res = await fetch(item.url)
      if (!res.ok) {
        console.warn(`[GPT Image] 下载图片失败 (${res.status}): ${item.url}`)
        return null
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const mimeType = res.headers.get('content-type') || 'image/png'
      return { data: buffer.toString('base64'), mimeType }
    } catch (err) {
      console.warn(`[GPT Image] 下载图片异常: ${item.url}`, err)
      return null
    }
  }

  console.warn(`[GPT Image] 响应条目无 b64_json 也无 url`)
  return null
}

// ===== 工具执行上下文 =====

/** GPT Image 工具执行所需的额外上下文 */
export interface GptImageContext {
  /** 对话 ID（用于保存附件） */
  conversationId: string
  /** 当前用户消息的附件列表 */
  currentAttachments?: FileAttachment[]
  /** 前一轮用户消息的附件 */
  previousUserAttachments?: FileAttachment[]
  /** 前一轮助手消息的附件 */
  previousAssistantAttachments?: FileAttachment[]
}

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL = 'gpt-image-2'

// ===== 工具元数据 =====

export const GPT_IMAGE_TOOL_META: ChatToolMeta = {
  id: 'gpt-image',
  name: 'GPT Image',
  description: 'AI 图片生成与编辑（基于 OpenAI GPT Image）',
  params: [
    { name: 'prompt', type: 'string', description: '图片生成/编辑描述', required: true },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<gpt_image_instructions>
你拥有 AI 图片生成和编辑能力（GPT Image）。

**generate_image — 生成/编辑图片：**
当用户需要创建或修改图片时调用：
- 用户要求画画、生成图片、创作插图
- 用户上传了图片并要求修改、编辑、调整
- 用户想要基于描述生成视觉内容

**参数说明：**
- prompt: 详细描述想要生成的图片内容，用中文或英文描述均可
- size: 可选图片尺寸 "1024x1024"(默认) / "1536x1024"(横向) / "1024x1536"(纵向) / "2048x2048" / "3072x2048" / "2048x3072" / "4096x4096"
- quality: 可选质量 "auto"(默认) / "low" / "medium" / "high"
- numberOfImages: 可选生成数量 1-10（默认 1），用户要求多张时设置
- useReferenceImages: 当用户上传了参考图或要求修改之前生成的图片时设为 true

**使用技巧：**
- 生成新图片时用详细的描述
- 编辑图片时设置 useReferenceImages: true，并在 prompt 中描述要做的修改
- GPT Image 支持高质量写实风格、文字渲染、精确编辑等多种场景
- 图片生成后会自动展示在对话中，你只需自然地描述图片内容即可
</gpt_image_instructions>`,
}

// ===== 工具定义（ToolDefinition 格式，传给 Provider） =====

export const GPT_IMAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'generate_image',
    description: 'Generate or edit images using AI (OpenAI GPT Image). Supports text-to-image generation, reference image editing, and iterative modifications.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or the edits to make.',
        },
        size: {
          type: 'string',
          description: 'Image size / resolution',
          enum: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '3072x2048', '2048x3072', '4096x4096'],
        },
        quality: {
          type: 'string',
          description: 'Image quality level',
          enum: ['auto', 'low', 'medium', 'high'],
        },
        useReferenceImages: {
          type: 'string',
          description: 'Set to "true" to use uploaded reference images for editing',
          enum: ['true', 'false'],
        },
        numberOfImages: {
          type: 'number',
          description: 'Number of images to generate (1-10, default 1)',
        },
      },
      required: ['prompt'],
    },
  },
]

// ===== 可用性检查 =====

/**
 * 检查 GPT Image 工具是否可用（API Key 已配置）
 */
export function isGptImageAvailable(): boolean {
  const credentials = getToolCredentials('gpt-image')
  return !!credentials.apiKey
}

// ===== 工具执行 =====

/** 工具名称集合 */
const GPT_IMAGE_TOOL_NAMES = new Set(['generate_image'])

/**
 * 判断是否为 GPT Image 工具调用
 */
export function isGptImageToolCall(toolName: string): boolean {
  return GPT_IMAGE_TOOL_NAMES.has(toolName)
}

/**
 * 收集参考图的 base64 数据
 *
 * 按时间从早到晚排列：前一轮用户附件 → 前一轮助手附件 → 当前用户附件
 */
function collectReferenceImages(context: GptImageContext): Array<{ data: string; media_type: string }> {
  const images: Array<{ data: string; media_type: string }> = []

  const allAttachments: FileAttachment[] = [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]

  for (const attachment of allAttachments) {
    if (!isImageAttachment(attachment.mediaType)) continue

    try {
      const base64 = readAttachmentAsBase64(attachment.localPath)
      images.push({
        data: base64,
        media_type: attachment.mediaType,
      })
    } catch (error) {
      console.warn(`[GPT Image] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }

  return images
}

/**
 * 执行 GPT Image 工具调用
 */
export async function executeGptImageTool(
  toolCall: ToolCall,
  context: GptImageContext,
): Promise<ToolResult> {
  const credentials = getToolCredentials('gpt-image')

  if (!credentials.apiKey) {
    return {
      toolCallId: toolCall.id,
      content: 'GPT Image 未配置 API Key',
      isError: true,
    }
  }

  try {
    const prompt = toolCall.arguments.prompt as string
    const size = toolCall.arguments.size as string | undefined
    const quality = toolCall.arguments.quality as string | undefined
    const useReferenceImages = toolCall.arguments.useReferenceImages === 'true'
    const numberOfImages = typeof toolCall.arguments.numberOfImages === 'number'
      ? Math.min(Math.max(Math.round(toolCall.arguments.numberOfImages), 1), 10)
      : 1

    if (!prompt) {
      return {
        toolCallId: toolCall.id,
        content: '参数缺失: prompt',
        isError: true,
      }
    }

    const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
    const model = credentials.model?.trim() || DEFAULT_MODEL

    // 收集参考图
    const referenceImages = useReferenceImages ? collectReferenceImages(context) : []

    // 构建请求体
    const requestBody: Record<string, unknown> = {
      model,
      prompt,
      n: numberOfImages,
      response_format: 'b64_json',
    }

    if (size) {
      requestBody.size = size
    }

    if (quality) {
      requestBody.quality = quality
    }

    // 如果有参考图，使用第一张作为编辑基础
    if (referenceImages.length > 0) {
      requestBody.image = referenceImages[0]
    }

    const url = `${baseUrl}/v1/images/generations`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[GPT Image] API 请求失败 (${response.status}):`, errorText)
      return {
        toolCallId: toolCall.id,
        content: `GPT Image API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`,
        isError: true,
      }
    }

    const data = (await response.json()) as GptImageResponse

    if (data.error) {
      return {
        toolCallId: toolCall.id,
        content: `GPT Image API 错误: ${data.error.message}`,
        isError: true,
      }
    }

    if (!data.data || data.data.length === 0) {
      return {
        toolCallId: toolCall.id,
        content: '未生成任何图片',
        isError: true,
      }
    }

    const generatedAttachments: FileAttachment[] = []
    const revisedPrompts: string[] = []

    // 解析响应：提取图片和修订提示词（兼容 b64_json 和 url 两种格式）
    for (const item of data.data) {
      const imageData = await resolveImageBase64(item, credentials.apiKey)
      if (imageData) {
        const ext = imageData.mimeType === 'image/jpeg' ? '.jpg' : '.png'
        const result = saveAttachment({
          conversationId: context.conversationId,
          filename: `gpt-image-${randomUUID().slice(0, 8)}${ext}`,
          mediaType: imageData.mimeType,
          data: imageData.data,
        })
        generatedAttachments.push(result.attachment)
        console.log(`[GPT Image] 已保存图片: ${result.attachment.localPath} (${result.attachment.size} 字节)`)
      }
      if (item.revised_prompt) {
        revisedPrompts.push(item.revised_prompt)
      }
    }

    // 构建返回结果
    const imageCount = generatedAttachments.length
    const resultText = imageCount > 0
      ? `图片已成功生成（${imageCount} 张）${revisedPrompts.length > 0 ? `\n\n修订后的提示词:\n${revisedPrompts.join('\n')}` : ''}`
      : '未生成图片内容'

    return {
      toolCallId: toolCall.id,
      content: resultText,
      generatedAttachments: generatedAttachments.length > 0 ? generatedAttachments : undefined,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[GPT Image] 执行失败:`, error)
    return {
      toolCallId: toolCall.id,
      content: `图片生成失败: ${msg}`,
      isError: true,
    }
  }
}

/**
 * 清除对话的生图历史（对话删除时调用）
 */
export function clearGptImageHistory(conversationId: string): void {
  // GPT Image 不需要多轮对话历史管理，此函数保留用于接口一致性
  void conversationId
}
