/** Agent 文件预览工具的 runtime-neutral 契约。 */

export type InspectPreviewMode = 'content' | 'visual' | 'both'
export type InspectPreviewScope = 'overview' | 'page' | 'all'

export type AgentPreviewFileKind =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'unknown'

export type AgentPreviewImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface InspectPreviewInput {
  filePath: string
  mode?: InspectPreviewMode
  scope?: InspectPreviewScope
  page?: number
  previousRevision?: string
}

export interface AgentPreviewImage {
  data: string
  mediaType: AgentPreviewImageMediaType
  filename?: string
  page?: number
}

/** 主进程与隐藏 renderer 之间的受控任务载荷，不直接暴露给模型。 */
export interface AgentPreviewRenderTask {
  id: string
  /** 仅用于 renderer 的扩展名类型选择；不包含本机路径。 */
  fileName: string
  sourceUrl: string
  kind: AgentPreviewFileKind
  scope: InspectPreviewScope
  page?: number
  text?: string
}

export interface AgentPreviewRenderOutput {
  images: AgentPreviewImage[]
  warnings?: string[]
}

export interface InspectPreviewContent {
  text: string
  truncated: boolean
  pageCount?: number
}

export interface InspectPreviewVisual {
  scope: InspectPreviewScope
  page?: number
  images: AgentPreviewImage[]
}

export interface InspectPreviewFile {
  name: string
  kind: AgentPreviewFileKind
  size: number
  modifiedAt: string
  revision: string
}

export interface InspectPreviewResult {
  file: InspectPreviewFile
  changedSincePreviousRevision?: boolean
  content?: InspectPreviewContent
  visual?: InspectPreviewVisual
  warnings?: string[]
}

export type InspectPreviewErrorCode =
  | 'invalid_input'
  | 'file_not_found'
  | 'unauthorized_path'
  | 'unsupported_file_type'
  | 'invalid_page'
  | 'page_out_of_range'
  | 'file_too_large'
  | 'render_budget_exceeded'
  | 'renderer_failed'
  | 'file_changed_during_inspection'

export interface InspectPreviewError {
  error: {
    code: InspectPreviewErrorCode
    message: string
    retryable: boolean
  }
  filePath?: string
}

/** 主进程和隐藏 renderer 共享的资源预算；具体格式解析器可进一步收紧。 */
export const AGENT_PREVIEW_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxPages: 80,
  maxImagesPerRequest: 80,
  maxImagePixels: 16_000_000,
  maxPayloadBytes: 30 * 1024 * 1024,
  maxTextChars: 200_000,
} as const

export const AGENT_PREVIEW_DEFAULT_MODE_BY_KIND: Readonly<Record<AgentPreviewFileKind, InspectPreviewMode>> = {
  text: 'content',
  markdown: 'both',
  html: 'both',
  image: 'both',
  pdf: 'both',
  document: 'both',
  spreadsheet: 'both',
  presentation: 'both',
  unknown: 'content',
}
