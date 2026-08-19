import { sendAgentLocalImage, type AgentImageOutputContext } from './agent-image-output-service'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details?: unknown }

function result(payload: Awaited<ReturnType<typeof sendAgentLocalImage>>): ToolResult {
  return {
    // Marker 必须是独立的原始文本，方便 Agent 原样放入最终消息，也让现有工具结果 renderer 可预览。
    content: [{
      type: 'text',
      text: `图片已安全复制到当前会话输出目录。请在最终回复中原样保留以下图片标记，并在标记外用正常文字说明图片内容：\n${payload.marker}`,
    }],
    details: payload,
  }
}

/** Claude runtime 的受控本地图片输出 MCP 工具。 */
export async function injectAgentImageOutputMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: AgentImageOutputContext,
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }

  const server = sdk.createSdkMcpServer({
    name: 'agent-image-output',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'send_local_image',
        'Send an existing local PNG/JPEG/GIF/WebP as an image in the final Agent response. The path must be inside the current session workspace or an explicitly authorized attached directory. Returns a PROMA_IMAGE_ATTACHMENT marker; copy that marker unchanged into your final response. This tool does not generate or edit images.',
        {
          path: z.string().min(1).max(4096),
          caption: z.string().max(500).optional(),
        },
        async (args) => result(await sendAgentLocalImage(args, context)),
      ),
    ],
  })
  mcpServers['agent-image-output'] = server as unknown as Record<string, unknown>
}

/** Pi 与 Claude 应向模型返回完全相同的原始 marker 文本。 */
export function formatAgentImageOutputToolResult(payload: Awaited<ReturnType<typeof sendAgentLocalImage>>): ToolResult {
  return result(payload)
}
