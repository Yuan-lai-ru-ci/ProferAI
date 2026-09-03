import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import type {
  AgentPreviewFileKind,
  AgentPreviewImage,
  AGENT_PREVIEW_DEFAULT_MODE_BY_KIND,
  AGENT_PREVIEW_LIMITS,
  InspectPreviewInput,
  InspectPreviewResult,
  InspectPreviewError,
  InspectPreviewMode,
  InspectPreviewScope,
} from '@profer/shared'
import { AGENT_PREVIEW_DEFAULT_MODE_BY_KIND as DEFAULT_MODE, AGENT_PREVIEW_LIMITS as LIMITS } from '@profer/shared'

export interface PreviewInspectionContext {
  agentCwd: string
  allowedRoots: string[]
}

export interface PreviewRenderInput {
  /** 已通过 realpath 授权校验的主进程本地路径；绝不返回给模型或 renderer。 */
  filePath: string
  fileName: string
  kind: AgentPreviewFileKind
  scope: InspectPreviewScope
  page?: number
  /** Markdown 等 renderer 所需的受限文本，不是绝对路径。 */
  text?: string
}

export interface PreviewRenderOutput {
  images: AgentPreviewImage[]
  warnings?: string[]
}

export interface PreviewInspectionDependencies {
  render?: (input: PreviewRenderInput) => Promise<PreviewRenderOutput>
  readText?: (filePath: string) => Promise<string>
}

export type PreviewInspectionResult = InspectPreviewResult | InspectPreviewError

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'md', 'markdown', 'html', 'htm', 'svg', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'less', 'sh', 'bat', 'sql', 'graphql',
])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const HTML_EXTENSIONS = new Set(['html', 'htm'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

function error(code: InspectPreviewError['error']['code'], message: string, retryable = false): InspectPreviewError {
  return { error: { code, message, retryable } }
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

async function realDirectory(path: string): Promise<string | null> {
  try {
    const resolvedPath = await realpath(path)
    return (await stat(resolvedPath)).isDirectory() ? resolvedPath : null
  } catch {
    return null
  }
}

async function resolveAuthorizedFile(filePath: string, context: PreviewInspectionContext): Promise<string | InspectPreviewError> {
  if (typeof filePath !== 'string' || !filePath.trim()) return error('invalid_input', 'filePath 必须是非空字符串')
  // 非工作区会话可以拥有显式附加目录，但不应把 home 当作默认 cwd/授权根。
  if (!isAbsolute(filePath) && !context.agentCwd.trim()) return error('unauthorized_path', '当前会话没有可解析相对路径的 Agent 工作目录')

  const requested = isAbsolute(filePath) ? filePath : resolve(context.agentCwd, filePath)
  let target: string
  try {
    target = await realpath(requested)
  } catch {
    return error('file_not_found', `文件不存在或无法访问: ${basename(filePath)}`)
  }

  let targetStat
  try {
    targetStat = await stat(target)
  } catch {
    return error('file_not_found', `文件不存在或无法访问: ${basename(filePath)}`)
  }
  if (!targetStat.isFile()) return error('unsupported_file_type', '预览路径必须指向普通文件')

  const roots = await Promise.all([context.agentCwd, ...context.allowedRoots].filter(Boolean).map(realDirectory))
  const authorizedRoots = roots.filter((root): root is string => root !== null)
  if (!authorizedRoots.some((root) => isInside(root, target))) return error('unauthorized_path', '文件不在当前 Agent 已授权的目录内')
  return target
}

function kindFromPath(filePath: string): AgentPreviewFileKind {
  const extension = extname(filePath).slice(1).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (HTML_EXTENSIONS.has(extension)) return 'html'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  // 视觉 renderer 与现有人类预览共用 Silurus，目前只支持这些 OOXML 格式。
  // 不将 ODT/ODS/ODP 等压缩包伪装成可视觉预览文件。
  if (extension === 'docx') return 'document'
  if (extension === 'xlsx' || extension === 'csv' || extension === 'tsv') {
    return extension === 'csv' || extension === 'tsv' ? 'text' : 'spreadsheet'
  }
  if (extension === 'pptx') return 'presentation'
  if (TEXT_EXTENSIONS.has(extension) || !extension) return 'text'
  return 'unknown'
}

function defaultScope(_kind: AgentPreviewFileKind): InspectPreviewScope {
  // page 仅在 Agent 显式要求且携带页码时使用；非分页文件默认总览，避免隐含 page=undefined。
  return 'overview'
}

async function hashFile(filePath: string): Promise<{ revision: string; size: number; modifiedAt: string }> {
  const data = await readFile(filePath)
  const metadata = await stat(filePath)
  return {
    revision: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    size: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
  }
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= LIMITS.maxTextChars) return { text, truncated: false }
  return { text: text.slice(0, LIMITS.maxTextChars), truncated: true }
}

async function readStructuredContent(filePath: string, kind: AgentPreviewFileKind): Promise<string | undefined> {
  if (kind === 'pdf') {
    const { extractTextFromFile } = await import('./document-parser')
    return extractTextFromFile(filePath)
  }
  if (kind === 'document') {
    const { convertDocxToHtml } = await import('./file-preview-service')
    const result = await convertDocxToHtml(filePath, [filePath])
    return result?.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  if (kind === 'spreadsheet' || kind === 'presentation') {
    const { convertOfficeToHtml } = await import('./file-preview-service')
    const result = await convertOfficeToHtml(filePath, [filePath])
    return result?.text
  }
  return undefined
}

function validateInput(input: InspectPreviewInput): InspectPreviewError | null {
  if (!input || typeof input.filePath !== 'string' || !input.filePath.trim()) return error('invalid_input', 'filePath 必须是非空字符串')
  if (input.mode && !['content', 'visual', 'both'].includes(input.mode)) return error('invalid_input', 'mode 必须是 content、visual 或 both')
  if (input.scope && !['overview', 'page', 'all'].includes(input.scope)) return error('invalid_input', 'scope 必须是 overview、page 或 all')
  if (input.scope === 'page' && (!Number.isInteger(input.page) || (input.page ?? 0) < 1)) return error('invalid_page', 'scope=page 时 page 必须是从 1 开始的整数')
  if (input.scope !== 'page' && input.page !== undefined) return error('invalid_page', 'page 只能与 scope=page 一起使用')
  return null
}

/** 读取当前授权文件的内容和视觉预览；每次调用都重新计算 revision。 */
export async function inspectPreview(
  input: InspectPreviewInput,
  context: PreviewInspectionContext,
  dependencies: PreviewInspectionDependencies = {},
): Promise<PreviewInspectionResult> {
  const invalid = validateInput(input)
  if (invalid) return invalid

  const resolved = await resolveAuthorizedFile(input.filePath, context)
  if (typeof resolved !== 'string') return resolved
  const filePath = resolved
  const kind = kindFromPath(filePath)
  if (kind === 'unknown') return error('unsupported_file_type', `暂不支持预览此文件类型: ${basename(filePath)}`)

  let before: Awaited<ReturnType<typeof hashFile>>
  try {
    before = await hashFile(filePath)
  } catch {
    return error('file_not_found', `文件不存在或无法读取: ${basename(filePath)}`)
  }
  if (before.size > LIMITS.maxFileBytes) return error('file_too_large', `文件超过 ${Math.round(LIMITS.maxFileBytes / 1024 / 1024)}MB 大小限制`)

  const mode: InspectPreviewMode = input.mode ?? DEFAULT_MODE[kind]
  const scope = input.scope ?? defaultScope(kind)
  const result: InspectPreviewResult = {
    file: { name: basename(filePath), kind, size: before.size, modifiedAt: before.modifiedAt, revision: before.revision },
  }
  if (input.previousRevision !== undefined) result.changedSincePreviousRevision = input.previousRevision !== before.revision

  try {
    if (mode === 'content' || mode === 'both') {
      let text: string | undefined
      if (TEXT_EXTENSIONS.has(extname(filePath).slice(1).toLowerCase()) || !extname(filePath)) {
        text = await (dependencies.readText?.(filePath) ?? readFile(filePath, 'utf8'))
      } else {
        text = await readStructuredContent(filePath, kind)
      }
      if (text !== undefined) {
        const content = truncateText(text)
        result.content = { text: content.text, truncated: content.truncated }
      }
    }

    if (mode === 'visual' || mode === 'both') {
      if (!dependencies.render) return error('renderer_failed', '当前未连接 Agent 预览 renderer', true)
      // visual-only Markdown 仍需要 source text；不能因未请求 content 就渲染空白页面。
      let rendererText = result.content?.text
      if (kind === 'markdown' && rendererText === undefined) {
        const text = await (dependencies.readText?.(filePath) ?? readFile(filePath, 'utf8'))
        rendererText = truncateText(text).text
      }
      const rendered = await dependencies.render({
        filePath,
        fileName: basename(filePath),
        kind,
        scope,
        page: input.page,
        text: rendererText,
      })
      if (rendered.images.length === 0) return error('renderer_failed', '预览 renderer 未返回视觉图片', true)
      if (rendered.images.length > LIMITS.maxImagesPerRequest) return error('render_budget_exceeded', '视觉预览图片数量超过限制')
      const payloadBytes = rendered.images.reduce((total, image) => total + Math.floor(image.data.length * 0.75), 0)
      if (payloadBytes > LIMITS.maxPayloadBytes) return error('render_budget_exceeded', '视觉预览图片数据超过限制')
      result.visual = { scope, page: input.page, images: rendered.images }
      if (rendered.warnings?.length) result.warnings = rendered.warnings
    }

    const after = await hashFile(filePath)
    if (after.revision !== before.revision) return error('file_changed_during_inspection', '文件在检查期间发生变化，请重新调用 inspect_preview', true)
    return result
  } catch (caught) {
    if (caught instanceof Error && caught.message.includes('超过')) return error('render_budget_exceeded', caught.message)
    if (typeof caught === 'object' && caught && 'code' in caught && (caught as { code?: unknown }).code === 'page_out_of_range') {
      return error('page_out_of_range', caught instanceof Error ? caught.message : '页码超出范围')
    }
    return error('renderer_failed', caught instanceof Error ? caught.message : '预览失败', true)
  }
}

/**
 * 将已授权的真实文件转换为 renderer 仅可访问的 opaque profer-file URL。
 * 这是唯一把路径边界传入视觉 renderer 的位置；模型结果不会含绝对路径。
 */
export async function renderAuthorizedPreview(input: PreviewRenderInput): Promise<PreviewRenderOutput> {
  const { registerProferDirectoryPath, registerProferFilePath } = await import('./local-file-protocol')
  const { renderAgentPreview } = await import('./agent-preview-renderer')
  let sourceUrl: string
  if (input.kind === 'html') {
    const directoryUrl = registerProferDirectoryPath(dirname(input.filePath))
    sourceUrl = `${directoryUrl}/${encodeURIComponent(basename(input.filePath)).replace(/%2F/gi, '/')}`
  } else if (input.kind === 'pdf') {
    const { preparePdfPreview } = await import('./file-preview-service')
    const prepared = await preparePdfPreview(input.filePath, [input.filePath])
    if (!prepared) throw new Error('无法准备 PDF 预览')
    sourceUrl = prepared.tmpHtmlUrl
  } else {
    sourceUrl = registerProferFilePath(input.filePath)
  }
  return renderAgentPreview({ fileName: input.fileName, kind: input.kind, scope: input.scope, page: input.page }, sourceUrl, input.text)
}

export { kindFromPath, defaultScope }
