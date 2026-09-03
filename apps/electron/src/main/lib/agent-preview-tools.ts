import type { InspectPreviewInput, InspectPreviewResult } from '@profer/shared'
import {
  inspectPreview,
  renderAuthorizedPreview,
  type PreviewInspectionContext,
  type PreviewInspectionResult,
} from './preview-inspection-service'

export const AGENT_INSPECT_PREVIEW_TOOL_NAME = 'inspect_preview'
export const AGENT_INSPECT_PREVIEW_DESCRIPTION = 'Inspect an authorized local file using current on-disk content and, when requested or appropriate, visual preview images. Use after creating or modifying HTML, Markdown, images, PDF, DOCX, XLSX, or PPTX. mode is content, visual, or both; scope is overview, page (with 1-based page), or all. Every call returns the current revision, and previousRevision tells whether the file changed since the last observation. The tool never accepts arbitrary file URLs or paths outside the Agent workspace and attached directories.'

type RuntimeImageBlock = { type: 'image'; data: string; mimeType: string }
type RuntimeTextBlock = { type: 'text'; text: string }
export type AgentPreviewToolResult = { content: Array<RuntimeTextBlock | RuntimeImageBlock>; details: PreviewInspectionResult }

function modelSafeSummary(result: PreviewInspectionResult): Record<string, unknown> {
  if ('error' in result) return { error: result.error }
  return {
    file: result.file,
    changedSincePreviousRevision: result.changedSincePreviousRevision,
    content: result.content,
    visual: result.visual
      ? {
          scope: result.visual.scope,
          page: result.visual.page,
          images: result.visual.images.map(({ filename, mediaType, page, data }) => ({ filename, mediaType, page, bytes: Math.floor(data.length * 0.75) })),
        }
      : undefined,
    warnings: result.warnings,
  }
}

/** Claude/Pi 都消费的 runtime-neutral inspection result 转换；图片直接交给 runtime image block。 */
export function formatAgentPreviewToolResult(result: PreviewInspectionResult): AgentPreviewToolResult {
  const content: Array<RuntimeTextBlock | RuntimeImageBlock> = [{ type: 'text', text: JSON.stringify(modelSafeSummary(result), null, 2) }]
  if (!('error' in result)) {
    for (const image of result.visual?.images ?? []) {
      content.push({ type: 'image', data: image.data, mimeType: image.mediaType })
    }
  }
  return { content, details: result }
}

export async function executeAgentPreviewTool(input: InspectPreviewInput, context: PreviewInspectionContext): Promise<AgentPreviewToolResult> {
  const result = await inspectPreview(input, context, { render: renderAuthorizedPreview })
  return formatAgentPreviewToolResult(result)
}

/** Claude runtime 的 in-process MCP 注册。Pi 复用 executeAgentPreviewTool 而不重复授权/渲染。 */
export async function injectAgentPreviewMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: PreviewInspectionContext,
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'agent-preview',
    version: '1.0.0',
    tools: [
      sdk.tool(
        AGENT_INSPECT_PREVIEW_TOOL_NAME,
        AGENT_INSPECT_PREVIEW_DESCRIPTION,
        {
          filePath: z.string().min(1).max(4096),
          mode: z.enum(['content', 'visual', 'both']).optional(),
          scope: z.enum(['overview', 'page', 'all']).optional(),
          page: z.number().int().positive().optional(),
          previousRevision: z.string().min(1).max(200).optional(),
        },
        async (input) => executeAgentPreviewTool(input, context),
      ),
    ],
  })
  mcpServers['agent-preview'] = server as unknown as Record<string, unknown>
}
