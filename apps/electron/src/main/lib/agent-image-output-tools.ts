import { sendAgentLocalImage, type AgentImageOutputContext } from './agent-image-output-service'
import { filterDisabledTools } from '@profer/shared'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details?: unknown }

function result(payload: Awaited<ReturnType<typeof sendAgentLocalImage>>): ToolResult {
  return {
    content: [{
      text: '图片已安全复制到当前会话，并会自动显示在回复中。请用正常文字说明图片内容，不要输出任何内部图片协议标记。',
      type: 'text',
    }],
    // 结构化 details 由 Profer UI 直接消费；不再要求模型回显 marker。
    details: payload,
  }
}

/** Claude runtime 的受控本地图片输出 MCP 工具。 */
export async function injectAgentImageOutputMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: AgentImageOutputContext,
  disabledTools?: string[],
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }

  const server = sdk.createSdkMcpServer({
    name: 'agent-image-output',
    version: '1.0.0',
    tools: filterDisabledTools([
      sdk.tool(
        'send_local_image',
        'Send an existing local PNG/JPEG/GIF/WebP as an image in the final Agent response. The path must be inside the current session workspace or an explicitly authorized attached directory. Profer automatically attaches the verified image to the conversation; do not output internal image protocol markers. This tool does not generate or edit images.',
        {
          path: z.string().min(1).max(4096),
          caption: z.string().max(500).optional(),
        },
        async (args) => result(await sendAgentLocalImage(args, context)),
      ),
    ], disabledTools),
  })
  mcpServers['agent-image-output'] = server as unknown as Record<string, unknown>
}

/** Pi 与 Claude 共用相同的结构化图片工具结果。 */
export function formatAgentImageOutputToolResult(payload: Awaited<ReturnType<typeof sendAgentLocalImage>>): ToolResult {
  return result(payload)
}
