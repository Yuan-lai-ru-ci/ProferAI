import { randomUUID } from 'node:crypto'
import type { AgentImageGenerationCard } from '@profer/shared'
import {
  readAuthorizedAgentImage,
  writeAgentImageOutput,
  type AgentImageOutputContext,
  type AgentImageOutputResult,
} from './agent-image-output-service'
import {
  createImageGenerationRecord,
  getImageGenerationRecord,
  getLatestSuccessfulGeneration,
  toAgentImageGenerationCard,
  transitionImageGenerationRecord,
  type AgentImageGenerationRecord,
} from './agent-image-generation-records'
import { MAX_GPT_IMAGE_REFERENCES, generateGptImage, type GptImageQuality, type GptImageRequest, type GptImageResult, type GptImageSize } from './gpt-image-service'

let gptImageProvider: (request: GptImageRequest) => Promise<GptImageResult> = generateGptImage

/** Test-only seam; production always uses the shared GPT Image provider. */
export function __setAgentGptImageProviderForTest(provider: ((request: GptImageRequest) => Promise<GptImageResult>) | undefined): void {
  gptImageProvider = provider ?? generateGptImage
}

export interface AgentGptImageContext extends AgentImageOutputContext {
  sessionId: string
  /** Receives only durable, renderer-safe cards after their JSONL snapshots are appended. */
  onGenerationUpdate?: (record: AgentImageGenerationCard) => void
}

export interface AgentGptImageInput {
  toolCallId: string
  prompt: string
  size?: GptImageSize
  quality?: GptImageQuality
  referenceImagePaths?: string[]
  /** Use only the current session's latest succeeded generated image as one edit reference. */
  useLastGeneratedImage?: boolean
  /** Main-process-only lineage; renderer may not specify this through normal tool input. */
  retryOf?: string
  /** Main-process-only fixed source for retrying a last-generated-image edit. */
  referenceGenerationId?: string
  signal?: AbortSignal
}

export type AgentGptImageResult =
  | { ok: true; output: AgentImageOutputResult; mode: 'official' | 'byok'; revisedPrompt?: string; edited: boolean; generationId: string }
  | { ok: false; error: string; generationId?: string }

class AgentGptImageProviderError extends Error {}

function safeError(error: unknown): string {
  // Shared provider already maps HTTP/provider failures to a user-safe message. Preserve
  // that existing tool contract; local validation/write errors receive the standard prefix.
  if (error instanceof AgentGptImageProviderError) return error.message.slice(0, 500)
  const message = error instanceof Error ? error.message : String(error)
  return `图片生成失败：${message.slice(0, 500)}`
}

function publicImage(output: AgentImageOutputResult): NonNullable<AgentImageGenerationCard['image']> {
  return {
    localPath: output.image.localPath,
    filename: output.image.filename,
    mediaType: output.image.mediaType,
  }
}

function notify(context: AgentGptImageContext, record: AgentImageGenerationRecord): void {
  try { context.onGenerationUpdate?.(toAgentImageGenerationCard(record)) } catch (error) { console.error('[Agent GPT Image] lifecycle callback failed:', error) }
}

/**
 * Agent-facing image generation boundary. A record is durably created before any
 * reference/provider work. References are authorized before any provider request and
 * the provider result is only persisted through the established session output image protocol.
 */
export async function generateAgentGptImage(
  input: AgentGptImageInput,
  context: AgentGptImageContext,
): Promise<AgentGptImageResult> {
  const prompt = input.prompt.trim()
  const hasDirectPaths = (input.referenceImagePaths?.length ?? 0) > 0
  let record: AgentImageGenerationRecord | undefined

  try {
    const paths = input.referenceImagePaths ?? []
    const previous = input.useLastGeneratedImage
      ? (input.referenceGenerationId
          ? await getImageGenerationRecord({ sessionId: context.sessionId, agentCwd: context.agentCwd }, input.referenceGenerationId)
          : await getLatestSuccessfulGeneration({ sessionId: context.sessionId, agentCwd: context.agentCwd }))
      : undefined
    const reference = input.useLastGeneratedImage
      ? (previous ? { kind: 'last_generated' as const, generationId: previous.id } : { kind: 'last_generated' as const })
      : hasDirectPaths ? { kind: 'paths' as const } : { kind: 'none' as const }

    // Persist invocation before validation, artifact reads, or provider contact. This
    // makes rejected calls visible as honest failed cards too.
    record = await createImageGenerationRecord({
      sessionId: context.sessionId, agentCwd: context.agentCwd, toolCallId: input.toolCallId,
      prompt: prompt || '（无效提示词）', size: input.size, quality: input.quality, reference,
      retryOf: input.retryOf,
    })
    notify(context, record)

    if (!prompt) throw new Error('参数缺失：prompt')
    if (input.useLastGeneratedImage && hasDirectPaths) throw new Error('useLastGeneratedImage 不能与 referenceImagePaths 同时使用')
    if (paths.length > MAX_GPT_IMAGE_REFERENCES) throw new Error(`参考图最多只能提供 ${MAX_GPT_IMAGE_REFERENCES} 张。`)
    if (input.useLastGeneratedImage && (previous?.status !== 'succeeded' || !previous.image)) throw new Error('当前会话没有可用于编辑的已成功生成图片')
    const resolvedPaths = input.useLastGeneratedImage ? [previous!.image!.localPath] : paths

    const references = await Promise.all(resolvedPaths.map(async (path) => {
      const image = await readAuthorizedAgentImage(path, context)
      return { data: image.data.toString('base64'), mediaType: image.mediaType, filename: image.filename }
    }))
    const generated = await gptImageProvider({
      prompt, size: input.size, quality: input.quality, references,
      idempotencyKey: `agent-gpt-image:${context.sessionId}:${input.toolCallId}`, signal: input.signal,
    })
    if (!generated.ok) throw new AgentGptImageProviderError(generated.error)

    record = await transitionImageGenerationRecord({ sessionId: context.sessionId, agentCwd: context.agentCwd }, record.id, { status: 'saving' })
    notify(context, record)
    const output = await writeAgentImageOutput(generated.bytes, generated.mediaType, context, `generated-image-${input.toolCallId}`)
    record = await transitionImageGenerationRecord({ sessionId: context.sessionId, agentCwd: context.agentCwd }, record.id, {
      status: 'succeeded', image: publicImage(output), mode: generated.mode,
      ...(generated.mode === 'official' ? { chargedCredits: 5 as const } : {}), revisedPrompt: generated.revisedPrompt,
    })
    notify(context, record)
    return { ok: true, output, mode: generated.mode, revisedPrompt: generated.revisedPrompt, edited: references.length > 0, generationId: record.id }
  } catch (error) {
    console.error('[Agent GPT Image] failed:', error)
    const errorText = safeError(error)
    if (record && (record.status === 'requesting' || record.status === 'saving')) {
      try {
        const failed = await transitionImageGenerationRecord({ sessionId: context.sessionId, agentCwd: context.agentCwd }, record.id, { status: 'failed', error: errorText })
        notify(context, failed)
      } catch (transitionError) { console.error('[Agent GPT Image] failed to persist failure:', transitionError) }
    }
    return { ok: false, error: errorText, ...(record ? { generationId: record.id } : {}) }
  }
}

/** Main-process retry helper. It reconstructs inputs from a durable failed record only. */
export async function retryAgentGptImage(
  record: AgentImageGenerationRecord,
  context: AgentGptImageContext,
): Promise<AgentGptImageResult> {
  // `last_generated` retries must replay the original successful generation, not a newer
  // image created after the failed card. Feed that controlled artifact as an internal path;
  // external path-reference retries are rejected by IPC before reaching this helper.
  if (record.reference.kind === 'paths') {
    return { ok: false, error: '参考图编辑失败后请让 Agent 重新选择参考图，不能自动重试' }
  }
  const originalReference = record.reference.kind === 'last_generated' && record.reference.generationId
    ? await getImageGenerationRecord({ sessionId: context.sessionId, agentCwd: context.agentCwd }, record.reference.generationId)
    : undefined
  if (record.reference.kind === 'last_generated' && !originalReference?.image) {
    return { ok: false, error: '原始上一张生成图已不可用，无法安全重试' }
  }
  return generateAgentGptImage({
    toolCallId: randomUUID(), prompt: record.prompt, size: record.size, quality: record.quality,
    ...(record.reference.kind === 'last_generated' ? { useLastGeneratedImage: true, referenceGenerationId: originalReference!.id } : {}),
    retryOf: record.id,
  }, context)
}
