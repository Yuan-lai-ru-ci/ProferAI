export type AgentBlockKind = 'markdown' | 'table'
export type AgentCopyFormat = 'markdown' | 'plainText' | 'tsv'

export interface AgentMarkdownBlock {
  id: string
  source: string
  kind: AgentBlockKind
}

interface FenceOpener {
  character: '`' | '~'
  length: number
}

interface ListMarker {
  indent: number
  contentIndent: number
  ordered: boolean
  empty: boolean
}

const FENCE_OPENER_RE = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/
const FENCE_CLOSER_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/
const LIST_MARKER_RE = /^([ \t]{0,3})([-+*]|\d+[.)])(?:([ \t]+)(.*))?$/
const QUOTE_RE = /^[ \t]{0,3}>[ \t]?/
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]/
const SETEXT_HEADING_RE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/
const THEMATIC_BREAK_RE = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
const FENCE_LINE_RE = /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n?/gm

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index]!.includes('|') && TABLE_SEPARATOR_RE.test(lines[index + 1]!)
}

function isSetextHeading(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || isBlank(lines[index]!) || isBlockStart(lines, index)) return false
  return SETEXT_HEADING_RE.test(lines[index + 1]!)
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function parseFenceOpener(line: string): FenceOpener | null {
  const match = FENCE_OPENER_RE.exec(line)
  if (!match) return null
  const run = match[1]!
  return { character: run[0] as '`' | '~', length: run.length }
}

function isFenceCloser(line: string, opener: FenceOpener): boolean {
  const match = FENCE_CLOSER_RE.exec(line)
  if (!match) return false
  const run = match[1]!
  return run[0] === opener.character && run.length >= opener.length
}

function leadingIndent(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0
}

function parseListMarker(line: string): ListMarker | null {
  const match = LIST_MARKER_RE.exec(line)
  if (!match) return null
  const indent = match[1]!.length
  const markerWidth = match[2]!.length
  const followingWhitespace = match[3]?.length ?? 1
  return {
    indent,
    contentIndent: indent + markerWidth + followingWhitespace,
    ordered: /^\d/.test(match[2]!),
    empty: !(match[4] ?? '').trim(),
  }
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]!
  return Boolean(
    parseFenceOpener(line) ||
    isTableStart(lines, index) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    parseListMarker(line) ||
    THEMATIC_BREAK_RE.test(line),
  )
}

/** 读取一个顶层列表项；嵌套列表与缩进续行保留在父项中，同级项独立成块。 */
function readListItemEnd(lines: string[], start: number, first: ListMarker): number {
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      const next = i + 1 < lines.length ? lines[i + 1]! : ''
      const nextMarker = parseListMarker(next)
      if (nextMarker && nextMarker.indent <= first.indent) break
      if (!isBlank(next) && leadingIndent(next) >= first.contentIndent) {
        i++
        continue
      }
      break
    }

    const marker = parseListMarker(line)
    if (marker) {
      if (marker.indent < first.contentIndent) break
      i++
      continue
    }

    if (leadingIndent(line) >= first.contentIndent || (!first.empty && !isBlockStart(lines, i))) {
      i++
      continue
    }
    break
  }
  return i
}

/** 连续引用行属于同一个 Markdown block；空行后的引用行也保持在同一块内。 */
function readQuoteEnd(lines: string[], start: number): number {
  let i = start + 1
  while (i < lines.length) {
    if (QUOTE_RE.test(lines[i]!)) {
      i++
      continue
    }
    if (isBlank(lines[i]!) && i + 1 < lines.length && QUOTE_RE.test(lines[i + 1]!)) {
      i++
      continue
    }
    break
  }
  return i
}

/** 划词所在块变化事件：Agent 历史选区层派发，消息块工具栏据此固定显示在选中的块上。 */
export const AGENT_BLOCK_SELECTION_EVENT = 'profer:agent-block-selection'

/** 工具栏「引用」按钮触发：由 Agent 历史选区层接手当前划词并写入引用。 */
export const AGENT_SELECTION_QUOTE_EVENT = 'profer:quote-current-selection'

/** 工具栏「探索分支」按钮触发：由 Agent 历史选区层接手当前划词并创建分支。 */
export const AGENT_SELECTION_EXPLORE_EVENT = 'profer:explore-current-selection'

/** 块元素的 DOM 属性名，用于从文本选区回溯到所属 Markdown 块。 */
export const AGENT_BLOCK_ID_ATTRIBUTE = 'data-agent-block-id'

/** 将回答按 Markdown 块级节点切分；代码块、表格、列表和引用始终保持整体。 */
export function parseAgentMarkdownBlocks(markdown: string): AgentMarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: AgentMarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (isBlank(lines[i]!)) {
      i++
      continue
    }

    const start = i
    const fence = parseFenceOpener(lines[i]!)
    if (fence) {
      i++
      while (i < lines.length && !isFenceCloser(lines[i]!, fence)) i++
      if (i < lines.length) i++
      blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'markdown' })
      continue
    }

    if (isSetextHeading(lines, i)) {
      i += 2
      blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'markdown' })
      continue
    }

    if (isTableStart(lines, i)) {
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && !isBlank(lines[i]!)) i++
      blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'table' })
      continue
    }

    const list = parseListMarker(lines[i]!)
    if (list) {
      i = readListItemEnd(lines, i, list)
      blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'markdown' })
      continue
    }

    if (QUOTE_RE.test(lines[i]!)) {
      i = readQuoteEnd(lines, i)
      blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'markdown' })
      continue
    }

    if (HEADING_RE.test(lines[i]!) || THEMATIC_BREAK_RE.test(lines[i]!)) {
      i++
      blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'markdown' })
      continue
    }

    i++
    while (i < lines.length && !isBlank(lines[i]!) && !isBlockStart(lines, i)) i++
    blocks.push({ id: `${blocks.length}`, source: lines.slice(start, i).join('\n'), kind: 'markdown' })
  }
  return blocks
}

export interface AgentBlockSelectionUpdate {
  selectedIds: Set<string>
  selecting: boolean
}

/** 返回两个块之间的闭区间，用于首次跨块点击和 Shift 补选。 */
export function selectAgentBlockRange(
  blocks: readonly AgentMarkdownBlock[],
  fromId: string,
  toId: string,
): Set<string> {
  const fromIndex = blocks.findIndex((block) => block.id === fromId)
  const toIndex = blocks.findIndex((block) => block.id === toId)
  if (fromIndex < 0 || toIndex < 0) return new Set([toId])
  const start = Math.min(fromIndex, toIndex)
  const end = Math.max(fromIndex, toIndex)
  return new Set(blocks.slice(start, end + 1).map((block) => block.id))
}

/** 切换块选中状态；最后一个块取消后返回已退出多选的状态。 */
export function toggleAgentBlockSelection(selectedIds: ReadonlySet<string>, blockId: string): AgentBlockSelectionUpdate {
  const next = new Set(selectedIds)
  if (next.has(blockId)) next.delete(blockId)
  else next.add(blockId)
  return { selectedIds: next, selecting: next.size > 0 }
}

/** 把 Markdown 内容转换成适合普通文本剪贴板的内容。 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(FENCE_LINE_RE, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]\s|\d+[.)]\s)/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function scanMarkdownTableRow(line: string): string[] {
  const trimmedLine = line.trim()
  const cells: string[] = []
  let cell = ''
  let trailingBackslashes = 0
  let lastPipeEscaped = false

  for (const character of trimmedLine) {
    if (character === '|') {
      lastPipeEscaped = trailingBackslashes % 2 === 1
      if (lastPipeEscaped) {
        cell = `${cell.slice(0, -1)}|`
        trailingBackslashes = 0
      } else {
        cells.push(cell.trim())
        cell = ''
        trailingBackslashes = 0
      }
      continue
    }

    lastPipeEscaped = false

    cell += character
    trailingBackslashes = character === '\\' ? trailingBackslashes + 1 : 0
  }
  cells.push(cell.trim())

  if (trimmedLine.startsWith('|')) cells.shift()
  if (trimmedLine.endsWith('|') && !lastPipeEscaped && cells.length > 0) cells.pop()
  return cells
}

function tableRows(source: string): string[][] {
  return source.split('\n')
    .filter((line) => line.includes('|') && !TABLE_SEPARATOR_RE.test(line))
    .map(scanMarkdownTableRow)
}

export function tableMarkdownToTsv(source: string): string {
  return tableRows(source).map((row) => row.map((cell) => cell.replace(/\s*\n\s*/g, ' ')).join('\t')).join('\n')
}

/** 单块序列化；表格格式与普通 Markdown/纯文本格式独立。 */
export function serializeAgentBlock(block: AgentMarkdownBlock, format: AgentCopyFormat): string {
  if (block.kind === 'table') return format === 'tsv' ? tableMarkdownToTsv(block.source) : block.source
  return format === 'plainText' ? markdownToPlainText(block.source) : block.source
}

/** 返回 hover 块所在连续选区的首块下标；未 hover 或未命中时返回 -1。 */
export function findAgentSelectionToolbarAnchor(
  blocks: readonly AgentMarkdownBlock[],
  selectedIds: ReadonlySet<string>,
  hoveredBlockId: string | null,
  selecting: boolean,
): number {
  let index = blocks.findIndex((block) => block.id === hoveredBlockId)
  if (index < 0 || !selecting || !selectedIds.has(blocks[index]!.id)) return index
  while (index > 0 && selectedIds.has(blocks[index - 1]!.id)) index--
  return index
}

/** 划词固定显示操作条时返回该块下标；未固定或块不属于本条消息时返回 -1。 */
export function findPinnedBlockIndex(blocks: readonly AgentMarkdownBlock[], pinnedBlockId: string | null): number {
  if (!pinnedBlockId) return -1
  return blocks.findIndex((block) => block.id === pinnedBlockId)
}

/** 决定单个块是否渲染操作条：划词固定优先（仅非多选），其次 hover 锚点；多选中未选块不渲染。 */
export function resolveToolbarBlock(params: {
  block: AgentMarkdownBlock
  index: number
  selecting: boolean
  selectedIds: ReadonlySet<string>
  pinnedIndex: number
  toolbarAnchorIndex: number
  hoveredBlock: AgentMarkdownBlock | null
}): AgentMarkdownBlock | null {
  if (params.selecting && !params.selectedIds.has(params.block.id)) return null
  if (!params.selecting && params.pinnedIndex >= 0) return params.index === params.pinnedIndex ? params.block : null
  return params.index === params.toolbarAnchorIndex ? params.hoveredBlock : null
}

export interface AgentCopySelection {
  blocks: AgentMarkdownBlock[]
  markdownFormat: 'markdown' | 'plainText'
  tableFormat: 'markdown' | 'tsv'
  tableFormats?: ReadonlyMap<string, 'markdown' | 'tsv'>
}

/** 按原始顺序合并选择；普通块和表格块各自服从自己的格式。 */
export function serializeAgentSelection(selection: AgentCopySelection): string {
  return selection.blocks
    .map((block) => serializeAgentBlock(block, block.kind === 'table' ? selection.tableFormats?.get(block.id) ?? selection.tableFormat : selection.markdownFormat))
    .filter((text) => text.length > 0)
    .join('\n\n')
}
