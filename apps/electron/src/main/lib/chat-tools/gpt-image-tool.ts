/**
 * GPT Image Chat adapter. Provider transport lives in ../gpt-image-service so
 * Agent and Chat share credentials, request semantics and response handling.
 */
import type { ToolCall, ToolResult, ToolDefinition } from '@profer/core'
import type { ChatToolMeta, FileAttachment } from '@profer/shared'
import { randomUUID } from 'node:crypto'
import { getGptImageCredentials } from '../chat-tool-config'
import { getTeamAuth } from '../auth-service'
import { saveAttachment, readAttachmentAsBase64, isImageAttachment } from '../attachment-service'
import {
  generateGptImage,
  GPT_IMAGE_QUALITIES,
  GPT_IMAGE_SIZES,
  type GptImageReference,
} from '../gpt-image-service'

export interface GptImageContext {
  conversationId: string
  currentAttachments?: FileAttachment[]
  previousUserAttachments?: FileAttachment[]
  previousAssistantAttachments?: FileAttachment[]
}

export const GPT_IMAGE_TOOL_META: ChatToolMeta = {
  id: 'gpt-image',
  name: 'GPT Image',
  description: 'AI 图片生成与参考图编辑（官方模式每张成功扣 5 积分）',
  params: [{ name: 'prompt', type: 'string', description: '图片生成/编辑描述', required: true }],
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

export const GPT_IMAGE_TOOL_DEFINITIONS: ToolDefinition[] = [{
  name: 'generate_image',
  description: 'Generate one image or edit uploaded reference images. Official mode charges 5 Profer credits only after successful delivery.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed image generation or editing instruction.' },
      size: { type: 'string', description: 'Image size', enum: [...GPT_IMAGE_SIZES] },
      quality: { type: 'string', description: 'Image quality', enum: [...GPT_IMAGE_QUALITIES] },
      useReferenceImages: { type: 'string', description: 'Set true to edit attached reference images', enum: ['true', 'false'] },
    },
    required: ['prompt'],
  },
}]

/** Official mode requires a team login; BYOK requires a decryptable main-process key. */
export function isGptImageAvailable(): boolean {
  const credentials = getGptImageCredentials()
  return credentials.mode === 'official' ? !!getTeamAuth() : !!credentials.apiKey
}

const GPT_IMAGE_TOOL_NAMES = new Set(['generate_image'])
export function isGptImageToolCall(toolName: string): boolean { return GPT_IMAGE_TOOL_NAMES.has(toolName) }

function collectReferenceImages(context: GptImageContext): GptImageReference[] {
  const images: GptImageReference[] = []
  for (const attachment of [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]) {
    if (!isImageAttachment(attachment.mediaType)) continue
    try {
      images.push({ data: readAttachmentAsBase64(attachment.localPath), mediaType: attachment.mediaType, filename: attachment.filename || 'reference-image' })
    } catch (error) {
      console.warn(`[GPT Image] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }
  return images
}

function errorResult(toolCallId: string, content: string): ToolResult { return { toolCallId, content, isError: true } }

export async function executeGptImageTool(toolCall: ToolCall, context: GptImageContext): Promise<ToolResult> {
  const prompt = typeof toolCall.arguments.prompt === 'string' ? toolCall.arguments.prompt.trim() : ''
  if (!prompt) return errorResult(toolCall.id, '参数缺失：prompt')
  const useReferenceImages = toolCall.arguments.useReferenceImages === 'true'
  const references = useReferenceImages ? collectReferenceImages(context) : []
  const size = typeof toolCall.arguments.size === 'string' ? toolCall.arguments.size : undefined
  const quality = typeof toolCall.arguments.quality === 'string' ? toolCall.arguments.quality : undefined
  const generated = await generateGptImage({
    prompt,
    size,
    quality,
    references,
    idempotencyKey: `gpt-image:${toolCall.id}`,
  })
  if (!generated.ok) return errorResult(toolCall.id, generated.error)

  try {
    const ext = generated.mediaType === 'image/jpeg' ? '.jpg' : generated.mediaType === 'image/webp' ? '.webp' : '.png'
    const saved = saveAttachment({
      conversationId: context.conversationId,
      filename: `gpt-image-${randomUUID().slice(0, 8)}${ext}`,
      mediaType: generated.mediaType,
      data: generated.bytes.toString('base64'),
    })
    const chargeHint = generated.mode === 'official' ? '，已扣 5 积分' : ''
    return {
      toolCallId: toolCall.id,
      content: `图片已成功${references.length ? '编辑' : '生成'}（1 张）${chargeHint}${generated.revisedPrompt ? `\n\n修订后的提示词：\n${generated.revisedPrompt}` : ''}`,
      generatedAttachments: [saved.attachment],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[GPT Image] 保存附件失败:', error)
    return errorResult(toolCall.id, `图片生成结果无法保存，本次不会报告为成功：${message}`)
  }
}

export function clearGptImageHistory(_conversationId: string): void {
  // Attachments follow attachment-service lifecycle; no separate state is retained.
}
