/** Agent 文本/工具结果中用于展示本地图片附件的协议标记。 */
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

  return {
    images,
    cleanText: text.replace(MARKER_REGEX, '').replace(/\n{3,}/g, '\n\n').trim(),
  }
}
