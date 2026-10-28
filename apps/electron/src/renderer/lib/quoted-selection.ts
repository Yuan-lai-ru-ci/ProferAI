import type { QuotedSelection } from '@/atoms/preview-atoms'
import type { QuotedSelectionSourceType } from '@/atoms/preview-atoms'
import { getFileBaseName } from '@/lib/file-utils'

export interface ParsedQuotedSelectionRef {
  path: string
  filename: string
  sourceType: QuotedSelectionSourceType
  label?: string
  /** 引用块编号（正文里的 `[n]` 与之对应） */
  ref?: number
  /** 引用正文（快照），溯源与「修改重发」重建引用时使用 */
  text?: string
  startLine?: number
  endLine?: number
  messageId?: string
  messageRole?: 'user' | 'assistant' | 'system'
}

export const SELECTION_ACTION_POPOVER_SELECTOR = '[data-selection-action-popover]'
export const SELECTION_ACTION_TARGET_SELECTOR = `${SELECTION_ACTION_POPOVER_SELECTOR}, [data-agent-toolbar-corridor]`

const QUOTED_FILE_REGEX = /<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g
const QUOTED_CONTEXT_REGEX = /<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g

/** 兼容 Markdown/富文本转义出的引用标签，例如 \\<quoted\\_context ...\\>。 */
function normalizeEscapedQuotedTags(content: string): string {
  const quoteTag = /\\?<\\?\/?quoted\\?_?(file|context)\b[^>]*?\\?>/gi
  return content.replace(quoteTag, (tag) => tag.replaceAll('\\', ''))
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function sanitizeQuotedText(value: string): string {
  return value
    .replace(/<\/quoted_file>/gi, '</quoted_file_>')
    .replace(/<\/quoted_context>/gi, '</quoted_context_>')
}

export function buildQuotedSelectionBlock(quotedSelection: QuotedSelection): string {
  const safeText = sanitizeQuotedText(quotedSelection.text)
  // 正文里的 `[n]` 是引用块的索引，块上必须带同一个编号，模型才能把「[2]」对上具体哪段。
  const refAttr = typeof quotedSelection.ref === 'number' ? ` ref="${quotedSelection.ref}"` : ''

  if (quotedSelection.sourceType === 'visualization' && quotedSelection.visualization) {
    const quote = quotedSelection.visualization
    return `<quoted_context${refAttr} source="visualization" label="${escapeXmlAttribute(quotedSelection.sourceLabel ?? quote.label)}" visualization_id="${escapeXmlAttribute(quote.visualizationId)}" revision="${escapeXmlAttribute(quote.revision)}" object_id="${escapeXmlAttribute(quote.objectId)}">\n${safeText}\n</quoted_context>\n\n`
  }

  if (quotedSelection.sourceType && quotedSelection.sourceType !== 'file') {
    const safeSource = escapeXmlAttribute(quotedSelection.sourceType)
    const safeLabel = escapeXmlAttribute(quotedSelection.sourceLabel ?? quotedSelection.filePath)
    // 只写有值的属性：空 message_id/role 在多引用场景会成倍放噪。
    const messageAttr = quotedSelection.messageId
      ? ` message_id="${escapeXmlAttribute(quotedSelection.messageId)}"`
      : ''
    const roleAttr = quotedSelection.messageRole
      ? ` role="${escapeXmlAttribute(quotedSelection.messageRole)}"`
      : ''
    return `<quoted_context${refAttr} source="${safeSource}" label="${safeLabel}"${messageAttr}${roleAttr}>\n${safeText}\n</quoted_context>\n\n`
  }

  const safePath = escapeXmlAttribute(quotedSelection.filePath)
  // 行号只在能算出时写入，便于模型定位同一文件里的多段引用。
  const startLineAttr = typeof quotedSelection.startLine === 'number' ? ` start_line="${quotedSelection.startLine}"` : ''
  const endLineAttr = typeof quotedSelection.endLine === 'number' ? ` end_line="${quotedSelection.endLine}"` : ''
  return `<quoted_file${refAttr} path="${safePath}"${startLineAttr}${endLineAttr}>\n${safeText}\n</quoted_file>\n\n`
}

/** 胶囊里文件名的最长字符数，超出后中段省略。 */
export const QUOTE_CHIP_LABEL_MAX = 14

/** 中段省略：`very-long-file-name.ts` → `very-lon…ame.ts`，比尾部截断更好认。 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return '…'
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/**
 * 胶囊上显示的**唯一**短词（12px 内联胶囊用）。
 *
 * 只承担指代，不承担来源说明：历史引用统一「历史」，文件用文件名，
 * 其余来源用固定词。来源细节（路径、行号、角色、时间）全部放 hover。
 *
 * 注意：不要再往这里拼 `sourceLabel`——那串本身已经是「Agent 历史 · Agent 回复」，
 * 拼起来会变成「历史 · Agent 历史 · Agent 回复」。
 */
export function describeQuoteChipLabel(quote: Pick<QuotedSelection, 'sourceType' | 'filePath'>): string {
  if (quote.sourceType === 'agent-history') return '历史'
  if (quote.sourceType === 'scratch-pad') return '草稿'
  if (quote.sourceType === 'visualization') return '图表'
  if (quote.sourceType === 'agent-interruption') return '中断'
  return truncateMiddle(getFileBaseName(quote.filePath) || '文件', QUOTE_CHIP_LABEL_MAX)
}

/** hover 第一行：来源细节（路径 + 行号 / 角色）。 */
export function describeQuoteChipDetail(quote: QuotedSelection): string {
  if (quote.sourceType === 'agent-history') {
    // 只用角色文案：sourceLabel 本身就是「Agent 历史 · Agent 回复」，拿来当细节等于又叠一层
    if (quote.messageRole === 'assistant') return 'Agent 回复'
    if (quote.messageRole === 'user') return '你的消息'
    if (quote.messageRole === 'system') return '系统消息'
    return 'Agent 历史'
  }
  if (quote.sourceType === 'scratch-pad') return '草稿纸'
  if (quote.sourceType === 'visualization') return quote.sourceLabel ?? '可视化'
  if (quote.sourceType === 'agent-interruption') return quote.sourceLabel ?? '中断说明'
  const lines = typeof quote.startLine === 'number' && typeof quote.endLine === 'number'
    ? ` · ${quote.startLine}–${quote.endLine} 行`
    : typeof quote.startLine === 'number'
      ? ` · ${quote.startLine} 行`
      : ''
  return `${quote.filePath}${lines}`
}

/** 引用去重键：来源类型 + 来源标识 + 选中文本。 */
export function getQuotedSelectionKey(quotedSelection: QuotedSelection): string {
  const source = quotedSelection.sourceType ?? 'file'
  const origin = source === 'file'
    ? quotedSelection.filePath
    : quotedSelection.messageId ?? quotedSelection.filePath
  return `${source}\u0000${origin}\u0000${quotedSelection.text}`
}

/** 追加一条引用；已存在同来源同文本时返回 duplicate=true 且列表不变。 */
export function appendQuotedSelection(
  list: readonly QuotedSelection[],
  quotedSelection: QuotedSelection,
): { list: QuotedSelection[]; duplicate: boolean } {
  const key = getQuotedSelectionKey(quotedSelection)
  if (list.some((item) => getQuotedSelectionKey(item) === key)) {
    return { list: [...list], duplicate: true }
  }
  return { list: [...list, quotedSelection], duplicate: false }
}

/** 多条引用按顺序拼成前缀块；顺序即用户在引用列表里看到的顺序。 */
export function buildQuotedSelectionsPrefix(list: readonly QuotedSelection[]): string {
  return list.map((item) => buildQuotedSelectionBlock(item)).join('')
}

function normalizeContextSourceType(value: string | undefined): QuotedSelectionSourceType {
  if (value === 'visualization') return 'visualization'
  if (value === 'scratch-pad') return 'scratch-pad'
  if (value === 'agent-interruption') return 'agent-interruption'
  return 'agent-history'
}

export function parseQuotedSelectionRefs(content: string): { quotes: ParsedQuotedSelectionRef[]; text: string } {
  const normalizedContent = normalizeEscapedQuotedTags(content)
  const quotes: ParsedQuotedSelectionRef[] = []

  const readNumber = (attr: string, source: string): number | undefined => {
    const match = source.match(new RegExp(`${attr}="(\\d+)"`))
    return match ? Number(match[1]) : undefined
  }

  let quoteMatch: RegExpExecArray | null
  QUOTED_FILE_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_FILE_REGEX.exec(normalizedContent)) !== null) {
    const pathMatch = quoteMatch[0].match(/path="([^"]*)"/)
    if (!pathMatch) continue
    const filePath = decodeXmlAttribute(pathMatch[1]!)
    const bodyMatch = quoteMatch[0].match(/>\n?([\s\S]*?)\n?<\/quoted_file>/)
    const ref = readNumber('ref', quoteMatch[0])
    const startLine = readNumber('start_line', quoteMatch[0])
    const endLine = readNumber('end_line', quoteMatch[0])
    quotes.push({
      path: filePath,
      filename: getFileBaseName(filePath),
      sourceType: 'file',
      ...(typeof ref === 'number' ? { ref } : {}),
      ...(typeof startLine === 'number' ? { startLine } : {}),
      ...(typeof endLine === 'number' ? { endLine } : {}),
      ...(bodyMatch ? { text: bodyMatch[1] } : {}),
    })
  }

  QUOTED_CONTEXT_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_CONTEXT_REGEX.exec(normalizedContent)) !== null) {
    const labelMatch = quoteMatch[0].match(/label="([^"]*)"/)
    const sourceMatch = quoteMatch[0].match(/source="([^"]*)"/)
    const messageIdMatch = quoteMatch[0].match(/message_id="([^"]*)"/)
    const roleMatch = quoteMatch[0].match(/ role="([^"]*)"/)
    const bodyMatch = quoteMatch[0].match(/>\n?([\s\S]*?)\n?<\/quoted_context>/)
    const label = labelMatch ? decodeXmlAttribute(labelMatch[1]!) : 'Agent 历史'
    const sourceType = normalizeContextSourceType(sourceMatch ? decodeXmlAttribute(sourceMatch[1]!) : 'agent-history')
    const rawRole = roleMatch ? decodeXmlAttribute(roleMatch[1]!) : ''
    const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' ? rawRole : undefined
    const messageId = messageIdMatch ? decodeXmlAttribute(messageIdMatch[1]!) : ''
    const ref = readNumber('ref', quoteMatch[0])
    quotes.push({
      path: label,
      filename: label,
      sourceType,
      label,
      ...(typeof ref === 'number' ? { ref } : {}),
      ...(bodyMatch ? { text: bodyMatch[1] } : {}),
      ...(messageId ? { messageId } : {}),
      ...(role ? { messageRole: role } : {}),
    })
  }

  const text = normalizedContent
    .replace(QUOTED_FILE_REGEX, '')
    .replace(QUOTED_CONTEXT_REGEX, '')
    .trim()

  return { quotes, text }
}

/**
 * 去掉正文里与引用块对应的 `[n]` 标记。
 *
 * 只删解析出来的编号，避免误伤用户手写的 `[1]`；用于「撤回到输入框」这类
 * 只回填可见正文、不重建引用节点的场景。
 */
export function stripQuoteMarkers(text: string, refs: readonly (number | undefined)[]): string {
  let result = text
  for (const ref of refs) {
    if (typeof ref !== 'number') continue
    result = result.replace(new RegExp(`\\[${ref}\\]\\s?`, 'g'), '')
  }
  return result.trim()
}

/** 解析结果 → 可再次插入编辑器的引用（缺正文的旧块无法重建，返回 null）。 */
export function quotedSelectionFromParsedRef(ref: ParsedQuotedSelectionRef, capturedAt = Date.now()): QuotedSelection | null {
  if (!ref.text) return null
  const isFile = ref.sourceType === 'file'
  return {
    text: ref.text,
    filePath: isFile ? ref.path : (ref.label ?? ref.path),
    sourceType: ref.sourceType,
    sourceLabel: isFile ? undefined : ref.label,
    messageId: ref.messageId,
    messageRole: ref.messageRole,
    startLine: ref.startLine,
    endLine: ref.endLine,
    capturedAt,
    ref: ref.ref,
  }
}

/**
 * 从历史消息正文里反解出引用（发送时引用块就落在用户消息文本里）。
 *
 * 这样「原文标记」不需要额外存储：打开会话、翻历史都能重新算出哪些段落被引过。
 * 只保留带 `messageId` 的（能在消息列表里定位的）引用。
 */
export function collectQuotedSelectionsFromTexts(texts: readonly string[]): QuotedSelection[] {
  const collected: QuotedSelection[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text || !text.includes('<quoted_')) continue
    const parsed = parseQuotedSelectionRefs(text)
    for (const ref of parsed.quotes) {
      const quote = quotedSelectionFromParsedRef(ref)
      if (!quote?.messageId) continue
      const key = `${quote.messageId}\u0000${quote.text}\u0000${quote.ref ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      collected.push(quote)
    }
  }
  return collected
}
