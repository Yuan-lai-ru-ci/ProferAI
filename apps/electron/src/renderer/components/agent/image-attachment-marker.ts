/** Agent 文本/工具结果中的历史本地图片附件协议标记（仅用于兼容旧会话）。 */
export const IMAGE_ATTACHMENT_MARKER_PREFIX = '[PROMA_IMAGE_ATTACHMENT:'

export type AgentImageAttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ParsedAgentImageAttachment {
  localPath: string
  filename: string
  mediaType: AgentImageAttachmentMediaType
}

const SUPPORTED_MEDIA_TYPES = new Set<AgentImageAttachmentMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

// 该 marker 来自受控主进程工具；renderer 仍仅接受已知的非执行型位图 MIME。
const MARKER_REGEX = /\[PROMA_IMAGE_ATTACHMENT:(.+?)\]/g

function isSupportedImageMediaType(value: unknown): value is AgentImageAttachmentMediaType {
  return typeof value === 'string' && SUPPORTED_MEDIA_TYPES.has(value as AgentImageAttachmentMediaType)
}

function parseImageValue(value: unknown): ParsedAgentImageAttachment | undefined {
  if (!value || typeof value !== 'object') return undefined
  const image = value as Record<string, unknown>
  if (typeof image.localPath !== 'string' || !image.localPath.trim()) return undefined
  if (typeof image.filename !== 'string' || !image.filename.trim()) return undefined
  if (!isSupportedImageMediaType(image.mediaType)) return undefined
  return { localPath: image.localPath, filename: image.filename, mediaType: image.mediaType }
}

/** 从主进程工具结果的结构化 details 中提取图片；兼容 send_local_image 与 generate_image。 */
export function parseAgentImageAttachmentDetails(value: unknown): ParsedAgentImageAttachment[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const candidates: unknown[] = [
    record.image,
    (record.output && typeof record.output === 'object') ? (record.output as Record<string, unknown>).image : undefined,
    ...(Array.isArray(record.imageAttachments) ? record.imageAttachments : []),
  ]
  const images: ParsedAgentImageAttachment[] = []
  for (const candidate of candidates) {
    const image = parseImageValue(candidate)
    if (image && !images.some((item) => item.localPath === image.localPath)) images.push(image)
  }
  return images
}

function isParsedAgentImageAttachment(value: unknown): value is ParsedAgentImageAttachment {
  if (!value || typeof value !== 'object') return false
  const image = value as Record<string, unknown>
  return typeof image.localPath === 'string'
    && image.localPath.length > 0
    && typeof image.filename === 'string'
    && image.filename.length > 0
    && typeof image.mediaType === 'string'
    && SUPPORTED_MEDIA_TYPES.has(image.mediaType as AgentImageAttachmentMediaType)
}

/**
 * Extract valid image attachment markers while removing every marker-shaped token from displayed text.
 * Invalid, forged, and unsupported MIME markers never reach the image loader.
 */
export function parseAgentImageAttachmentMarkers(text: string): {
  images: ParsedAgentImageAttachment[]
  cleanText: string
} {
  MARKER_REGEX.lastIndex = 0
  const images: ParsedAgentImageAttachment[] = []
  let match: RegExpExecArray | null
  while ((match = MARKER_REGEX.exec(text)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]!)
      if (isParsedAgentImageAttachment(parsed)) images.push(parsed)
    } catch {
      // Marker-like ordinary text and malformed payloads are deliberately ignored.
    }
  }

  MARKER_REGEX.lastIndex = 0
  const cleanText = text.replace(MARKER_REGEX, '').replace(/\n{3,}/g, '\n\n').trim()
  MARKER_REGEX.lastIndex = 0
  return { images, cleanText }
}
