import { readClipboardText, writeClipboardText } from './clipboard-agent-tools'

type ZodModule = typeof import('zod')
type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

/**
 * Claude runtime 的剪贴板 MCP 桥接；与 Pi 的 clipboard_read_text / clipboard_write_text 能力对齐。
 * 底层是主进程 Electron clipboard（UTF-8），避免 Agent 退化为 PowerShell Get-Clipboard 中文乱码。
 */
export async function injectClaudeClipboardMcpServer(
  sdk: ClaudeSdk,
  mcpServers: Record<string, Record<string, unknown>>,
): Promise<void> {
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = require('zod').z }

  const readOnly = { annotations: { readOnlyHint: true } }
  const server = sdk.createSdkMcpServer({
    name: 'clipboard',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'clipboard_read_text',
        '读取系统剪贴板文本。获取剪贴板内容请优先使用本工具，不要使用 PowerShell Get-Clipboard（Windows 控制台代码页会导致中文乱码）。',
        {},
        async () => {
          try {
            const { text, truncated, totalChars } = readClipboardText()
            return textResult({ text, truncated, totalChars, message: truncated ? `剪贴板文本超过上限，已截断到 ${text.length} 字符（原文 ${totalChars} 字符）。` : `已读取 ${totalChars} 个字符。` })
          } catch (error) {
            return textResult({ error: error instanceof Error ? error.message : '读取剪贴板失败。' })
          }
        },
        readOnly,
      ),
      sdk.tool(
        'clipboard_write_text',
        '写入文本到系统剪贴板。需要把文本放到剪贴板供之后手动粘贴时使用本工具；写入前请确认文本不含不应泄露到剪贴板的敏感信息。',
        { text: z.string().min(1).describe('要写入系统剪贴板的完整文本。') },
        async ({ text }) => {
          try {
            const { writtenChars } = writeClipboardText(text)
            return textResult({ writtenChars, message: `已写入 ${writtenChars} 个字符到系统剪贴板。` })
          } catch (error) {
            return textResult({ error: error instanceof Error ? error.message : '写入剪贴板失败。' })
          }
        },
      ),
    ],
  })
  mcpServers.clipboard = server as unknown as Record<string, unknown>
}
