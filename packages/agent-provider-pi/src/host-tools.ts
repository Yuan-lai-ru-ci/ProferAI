import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

export const HOST_TOOL_NAMES = ['open_file_preview', 'inspect_file_preview', 'inspect_preview', 'clipboard_write_text'] as const
export type HostToolName = typeof HOST_TOOL_NAMES[number]
export type HostToolResult = AgentToolResult<unknown> & { isError?: boolean }

/** SDK 仅由 provider 加载；Core 注入操作，不持有 Pi SDK。权限由 Pi adapter 统一执行。 */
export interface HostToolOperations {
  execute(name: HostToolName, input: Record<string, unknown>, signal?: AbortSignal, toolCallId?: string): Promise<HostToolResult>
  disabledTools?: readonly string[]
}

export const HOST_TOOL_DESCRIPTIONS: Record<HostToolName, string> = {
  open_file_preview: 'Open an authorized local PPTX in Profer’s official current-session file preview. The user and Agent continue working from the same visible preview context. Do not create Preview.html, open a browser, or capture a screenshot.',
  inspect_file_preview: 'Inspect one or more slides from the current user-visible Profer PPTX preview. This reads the same ready viewer and revision opened by open_file_preview; it never creates a hidden renderer or browser preview.',
  inspect_preview: 'Inspect current local Markdown/HTML/image/PDF/DOCX/XLSX/text content or visuals. Authorized workspace/attached paths only, no arbitrary file URLs. PPTX uses open_file_preview then inspect_file_preview, not this tool. mode: content/visual/both; scope: overview/page/all, 1-based page. Returns current revision; previousRevision detects changes.',
  clipboard_write_text: '写入文本到系统剪贴板。需要把文本放到剪贴板供之后手动粘贴时使用本工具；写入前请确认文本不包含不应泄露到剪贴板的敏感信息。',
}

export async function loadPiHostToolDefinitions(operations: HostToolOperations): Promise<ToolDefinition[]> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const filePath = Type.String({ minLength: 1, maxLength: 4096 })
  const scope = Type.Optional(Type.Union([Type.Literal('overview'), Type.Literal('page'), Type.Literal('all')]))
  const page = Type.Optional(Type.Integer({ minimum: 1 }))
  const schemas = {
    open_file_preview: Type.Object({ filePath, readOnly: Type.Optional(Type.Boolean()) }),
    inspect_file_preview: Type.Object({ filePath, scope, page }),
    inspect_preview: Type.Object({ filePath, mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('visual'), Type.Literal('both')])), scope, page,
      previousRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
    clipboard_write_text: Type.Object({ text: Type.String({ description: '要写入系统剪贴板的完整文本。' }) }),
  }
  const labels: Record<HostToolName, string> = {
    open_file_preview: '打开 Profer 文件预览', inspect_file_preview: '检查 Profer PPTX 正式预览',
    inspect_preview: '检查文件预览', clipboard_write_text: '写入系统剪贴板文本',
  }
  return HOST_TOOL_NAMES.filter(name => !operations.disabledTools?.includes(name)).map(name => sdk.defineTool({
    name, label: labels[name], description: HOST_TOOL_DESCRIPTIONS[name], parameters: schemas[name],
    execute: (id, input, signal) => operations.execute(name, input as Record<string, unknown>, signal, id),
  }) as ToolDefinition)
}
