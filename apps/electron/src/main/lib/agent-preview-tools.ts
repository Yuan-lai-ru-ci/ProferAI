import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { InspectPreviewInput, InspectPreviewResult, ProferEvent } from '@profer/shared'
import {
  inspectPreview,
  renderAuthorizedPreview,
  type PreviewInspectionContext,
  type PreviewInspectionResult,
} from './preview-inspection-service'

export const AGENT_INSPECT_PREVIEW_TOOL_NAME = 'inspect_preview'
export const AGENT_INSPECT_PREVIEW_DESCRIPTION = 'Inspect an authorized local file using current on-disk content and, when requested or appropriate, visual preview images. Use for Markdown, HTML, images, PDF, DOCX, XLSX, or text. Do not use this tool for PPTX; use open_file_preview so the user and Agent stay in Profer’s official file preview workflow. mode is content, visual, or both; scope is overview, page (with 1-based page), or all. Every call returns the current revision, and previousRevision tells whether the file changed since the last observation. The tool never accepts arbitrary file URLs or paths outside the Agent workspace and attached directories.'

type RuntimeImageBlock = { type: 'image'; data: string; mimeType: string }
type RuntimeTextBlock = { type: 'text'; text: string }
export type AgentPreviewToolResult = { content: Array<RuntimeTextBlock | RuntimeImageBlock>; details: PreviewInspectionResult }

export interface OpenFilePreviewContext extends PreviewInspectionContext {
  sessionId: string
  onRequest?: (event: Extract<ProferEvent, { type: 'preview_requested' }>) => void
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

async function resolveAuthorizedPptx(filePath: string, context: OpenFilePreviewContext): Promise<{ filePath: string; basePaths: string[] }> {
  const raw = filePath.trim()
  if (!raw) throw new Error('filePath 必须是非空字符串')
  if (extname(raw).toLowerCase() !== '.pptx') throw new Error('open_file_preview 仅用于 PPTX；其他文件请使用 inspect_preview 或对应的 Profer 文件预览入口。')
  if (!context.agentCwd.trim()) throw new Error('当前会话没有可用的 Agent 工作目录')
  const target = await realpath(isAbsolute(raw) ? raw : resolve(context.agentCwd, raw))
  if (!(await stat(target)).isFile()) throw new Error('预览路径必须指向普通文件')
  const roots: string[] = []
  for (const candidate of [context.agentCwd, ...context.allowedRoots]) {
    if (!candidate?.trim()) continue
    try {
      const root = await realpath(candidate)
      if ((await stat(root)).isDirectory()) roots.push(root)
    } catch {
      // 无法解析的授权根不参与授权判断。
    }
  }
  const basePaths = [...new Set(roots)]
  if (!basePaths.some((root) => isInside(root, target))) throw new Error('文件不在当前 Agent 已授权的目录内')
  return { filePath: target, basePaths }
}

/** 请求主窗口复用现有人类预览，不创建 Preview.html、不打开浏览器、不返回截图。 */
export async function executeOpenFilePreviewTool(input: { filePath: string; readOnly?: boolean }, context: OpenFilePreviewContext): Promise<AgentPreviewToolResult> {
  if (!context.onRequest) throw new Error('当前会话未连接 Profer 正式文件预览入口，未执行预览请求。')
  const resolved = await resolveAuthorizedPptx(input.filePath, context)
  const data = await readFile(resolved.filePath)
  const metadata = await stat(resolved.filePath)
  const revision = `sha256:${createHash('sha256').update(data).digest('hex')}`
  context.onRequest({
    type: 'preview_requested',
    sessionId: context.sessionId,
    filePath: resolved.filePath,
    basePaths: resolved.basePaths,
    readOnly: input.readOnly !== false,
  })
  const message = `已请求 Profer 正式文件预览：${basename(resolved.filePath)}。用户与 Agent 将围绕同一预览继续检查；修改文件后请再次请求预览。`
  return {
    content: [{ type: 'text', text: message }],
    details: {
      file: { name: basename(resolved.filePath), kind: 'presentation', size: metadata.size, modifiedAt: metadata.mtime.toISOString(), revision },
      warnings: [message],
    },
  }
}

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
  if (extname(input.filePath.trim()).toLowerCase() === '.pptx') {
    return formatAgentPreviewToolResult({
      error: {
        code: 'unsupported_file_type',
        message: 'PPTX 请使用 open_file_preview 进入 Profer 正式文件预览；不要为 PPTX 创建浏览器页面或旁路截图。',
        retryable: false,
      },
    })
  }
  const result = await inspectPreview(input, context, { render: renderAuthorizedPreview })
  return formatAgentPreviewToolResult(result)
}

/** Claude runtime 的 in-process MCP 注册。Pi 复用 executeAgentPreviewTool 而不重复授权/渲染。 */
export async function injectAgentPreviewMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: OpenFilePreviewContext,
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'agent-preview',
    version: '2.0.0',
    tools: [
      sdk.tool(
        'open_file_preview',
        'Open an authorized local PPTX in Profer’s official current-session file preview. The user and Agent continue working from the same visible preview context. Do not create Preview.html, open a browser, or capture a screenshot.',
        {
          filePath: z.string().min(1).max(4096),
          readOnly: z.boolean().optional(),
        },
        async (input) => executeOpenFilePreviewTool(input, context),
      ),
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
