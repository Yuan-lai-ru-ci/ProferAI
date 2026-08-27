import { randomUUID } from 'node:crypto'
import { getToolState } from './chat-tool-config'
import { isGptImageAvailable, } from './chat-tools/gpt-image-tool'
import { generateAgentGptImage, type AgentGptImageContext } from './agent-gpt-image-service'
import { GPT_IMAGE_QUALITIES, GPT_IMAGE_SIZES, type GptImageQuality, type GptImageSize } from './gpt-image-service'

export const AGENT_GPT_IMAGE_TOOL_NAME = 'generate_image'

const DESCRIPTION = 'Generate one image from a prompt, edit 1–4 authorized local PNG/JPEG/GIF/WebP reference files, or edit the latest successful image generated in this current Agent session with useLastGeneratedImage. useLastGeneratedImage cannot be combined with referenceImagePaths. Official mode charges 5 Profer credits only after successful delivery. Profer automatically attaches the delivered image to the conversation; do not output internal image protocol markers.'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details?: unknown; isError?: boolean }

export function isAgentGptImageAvailable(): boolean {
  return getToolState('gpt-image').enabled && isGptImageAvailable()
}

function claudeToolCallId(extra: unknown): string {
  if (extra && typeof extra === 'object') {
    const record = extra as Record<string, unknown>
    for (const key of ['toolCallId', 'tool_use_id', 'id']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  // Current SDK declaration intentionally types this metadata as unknown. Do not derive
  // a key from prompt/arguments: identical legitimate image requests must remain distinct.
  return randomUUID()
}

function toolResult(result: Awaited<ReturnType<typeof generateAgentGptImage>>): ToolResult {
  if (!result.ok) return { content: [{ type: 'text', text: result.error }], details: result, isError: true }
  const chargeHint = result.mode === 'official' ? '，已扣 5 积分' : ''
  return {
    content: [{
      type: 'text',
      text: `图片已成功${result.edited ? '编辑' : '生成'}（1 张）${chargeHint}，并会自动显示在当前回复中。${result.revisedPrompt ? `\n修订后的提示词：${result.revisedPrompt}` : ''}\n请用正常文字说明图片内容，不要输出任何内部图片协议标记。`,
    }],
    details: result.output,
  }
}

export function formatAgentGptImageToolResult(result: Awaited<ReturnType<typeof generateAgentGptImage>>): ToolResult {
  return toolResult(result)
}

/** Claude runtime's in-process MCP adapter for the shared Agent image service. */
export async function injectAgentGptImageMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: AgentGptImageContext,
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'agent-gpt-image', version: '1.0.0', tools: [
      sdk.tool(
        AGENT_GPT_IMAGE_TOOL_NAME,
        DESCRIPTION,
        {
          prompt: z.string().min(1).max(10_000),
          size: z.enum(GPT_IMAGE_SIZES).optional(),
          quality: z.enum(GPT_IMAGE_QUALITIES).optional(),
          referenceImagePaths: z.array(z.string().min(1).max(4096)).min(1).max(4).optional(),
          useLastGeneratedImage: z.boolean().optional(),
        },
        async (args, extra) => formatAgentGptImageToolResult(await generateAgentGptImage({
          prompt: args.prompt,
          size: args.size as GptImageSize | undefined,
          quality: args.quality as GptImageQuality | undefined,
          referenceImagePaths: args.referenceImagePaths,
          useLastGeneratedImage: args.useLastGeneratedImage,
          toolCallId: claudeToolCallId(extra),
        }, context)),
      ),
    ],
  })
  mcpServers['agent-gpt-image'] = server as unknown as Record<string, unknown>
}

export const AGENT_GPT_IMAGE_DESCRIPTION = DESCRIPTION
