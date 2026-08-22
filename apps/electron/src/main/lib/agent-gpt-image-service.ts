import {
  readAuthorizedAgentImage,
  writeAgentImageOutput,
  type AgentImageOutputContext,
  type AgentImageOutputResult,
} from './agent-image-output-service'
import { MAX_GPT_IMAGE_REFERENCES, generateGptImage, type GptImageQuality, type GptImageRequest, type GptImageResult, type GptImageSize } from './gpt-image-service'

let gptImageProvider: (request: GptImageRequest) => Promise<GptImageResult> = generateGptImage

/** Test-only seam; production always uses the shared GPT Image provider. */
export function __setAgentGptImageProviderForTest(provider: ((request: GptImageRequest) => Promise<GptImageResult>) | undefined): void {
  gptImageProvider = provider ?? generateGptImage
}

export interface AgentGptImageContext extends AgentImageOutputContext {
  sessionId: string
}

export interface AgentGptImageInput {
  toolCallId: string
  prompt: string
  size?: GptImageSize
  quality?: GptImageQuality
  referenceImagePaths?: string[]
  signal?: AbortSignal
}

export type AgentGptImageResult =
  | { ok: true; output: AgentImageOutputResult; mode: 'official' | 'byok'; revisedPrompt?: string; edited: boolean }
  | { ok: false; error: string }

/**
 * Agent-facing image generation boundary. Reference files are authorized before any
 * provider request and the provider result is only persisted through the established
 * session output marker protocol.
 */
export async function generateAgentGptImage(
  input: AgentGptImageInput,
  context: AgentGptImageContext,
): Promise<AgentGptImageResult> {
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, error: '参数缺失：prompt' }
  const paths = input.referenceImagePaths ?? []
  if (paths.length > MAX_GPT_IMAGE_REFERENCES) return { ok: false, error: `参考图最多只能提供 ${MAX_GPT_IMAGE_REFERENCES} 张。` }
  try {
    const references = await Promise.all(paths.map(async (path) => {
      const image = await readAuthorizedAgentImage(path, context)
      return { data: image.data.toString('base64'), mediaType: image.mediaType, filename: image.filename }
    }))
    const generated = await gptImageProvider({
      prompt,
      size: input.size,
      quality: input.quality,
      references,
      idempotencyKey: `agent-gpt-image:${context.sessionId}:${input.toolCallId}`,
      signal: input.signal,
    })
    if (!generated.ok) return generated
    const output = await writeAgentImageOutput(
      generated.bytes,
      generated.mediaType,
      context,
      `generated-image-${input.toolCallId}`,
    )
    return { ok: true, output, mode: generated.mode, revisedPrompt: generated.revisedPrompt, edited: references.length > 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[Agent GPT Image] failed:', error)
    return { ok: false, error: `图片生成失败：${message}` }
  }
}
