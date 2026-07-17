/**
 * 知识库语义分块
 *
 * 将 MinerU 解析后的 Markdown 论文内容按语义边界分块，为 Embedding 和检索做准备。
 * 优先使用 MinerU 的 content_list.json 按节分块，fallback 为按 Markdown 标题层级分块。
 */

import type { PaperChunk } from '@profer/shared'
import { randomUUID } from 'node:crypto'

/** 目标 chunk 大小（字符数，中文约 1000 字 ≈ 512 tokens） */
const TARGET_CHUNK_SIZE = 1000

/** 最大 chunk 大小（字符数） */
const MAX_CHUNK_SIZE = 2000

/** 相邻 chunk 重叠字符数 */
const OVERLAP_SIZE = 100

/**
 * MinerU content_list.json 中的条目类型
 */
interface ContentListItem {
  type: 'text' | 'title' | 'table' | 'formula' | 'image' | 'list'
  text?: string
  content?: string
  level?: number
  children?: ContentListItem[]
}

/**
 * 将论文 Markdown 内容分块
 *
 * @param markdown 完整的 Markdown 内容
 * @param paperId 论文 ID
 * @param contentList MinerU 的 content_list（可选，优先使用）
 * @returns 分块数组（不含 embedding）
 */
export function chunkPaper(
  markdown: string,
  paperId: string,
  contentList?: ContentListItem[],
): Omit<PaperChunk, 'embedding'>[] {
  if (contentList && contentList.length > 0) {
    return chunkFromContentList(contentList, paperId)
  }
  return chunkFromMarkdown(markdown, paperId)
}

/**
 * 从 MinerU content_list.json 按节分块（优先策略）
 */
function chunkFromContentList(
  contentList: ContentListItem[],
  paperId: string,
): Omit<PaperChunk, 'embedding'>[] {
  const chunks: Omit<PaperChunk, 'embedding'>[] = []
  let currentSection = ''
  let globalIndex = 0

  function processItems(items: ContentListItem[], sectionTitle: string) {
    let buffer = ''
    let bufferStart = globalIndex

    function flushBuffer() {
      if (buffer.trim().length === 0) return
      const chunkId = randomUUID()
      chunks.push({
        id: chunkId,
        paperId,
        content: buffer.trim(),
        sectionTitle,
        startIndex: bufferStart,
        endIndex: bufferStart + buffer.length,
      })
      buffer = ''
      bufferStart = globalIndex
    }

    for (const item of items) {
      const text = item.text || item.content || ''

      if (item.type === 'title') {
        // 遇到标题时刷新缓冲区并更新节标题
        flushBuffer()
        currentSection = text
        sectionTitle = text
        continue
      }

      if (item.type === 'table' || item.type === 'formula') {
        // 表格和公式作为独立 chunk
        flushBuffer()
        const chunkId = randomUUID()
        chunks.push({
          id: chunkId,
          paperId,
          content: text,
          sectionTitle,
          startIndex: globalIndex,
          endIndex: globalIndex + text.length,
        })
        globalIndex += text.length
        continue
      }

      // 递归处理子节点
      if (item.children && item.children.length > 0) {
        flushBuffer()
        processItems(item.children, sectionTitle)
        continue
      }

      // 普通文本：拼接到缓冲区
      if (buffer.length + text.length > MAX_CHUNK_SIZE) {
        flushBuffer()
      }
      buffer += text + '\n'
      globalIndex += text.length + 1
    }

    flushBuffer()
  }

  processItems(contentList, '')
  return chunks
}

/**
 * Fallback：按 Markdown 标题层级分块
 */
function chunkFromMarkdown(
  markdown: string,
  paperId: string,
): Omit<PaperChunk, 'embedding'>[] {
  const chunks: Omit<PaperChunk, 'embedding'>[] = []

  // 按 ## 和 ### 标题分割
  const sections = splitByHeadings(markdown)

  for (const section of sections) {
    const { title, content, startOffset } = section

    if (content.trim().length === 0) continue

    // 如果节内容很短，直接作为一个 chunk
    if (content.length <= MAX_CHUNK_SIZE) {
      const chunkId = randomUUID()
      chunks.push({
        id: chunkId,
        paperId,
        content: content.trim(),
        sectionTitle: title,
        startIndex: startOffset,
        endIndex: startOffset + content.length,
      })
      continue
    }

    // 长节按目标大小切分（保持段落边界）
    const paragraphs = content.split(/\n\n+/)
    let buffer = ''
    let bufferStart = startOffset

    for (const para of paragraphs) {
      const paraText = para.trim()
      if (!paraText) continue

      // 表格和公式块独立成 chunk
      if (paraText.startsWith('|') || paraText.startsWith('$$') || paraText.startsWith('$')) {
        if (buffer.trim()) {
          chunks.push(createChunk(paperId, title, buffer.trim(), bufferStart, bufferStart + buffer.length))
        }
        const paraOffset = startOffset + content.indexOf(paraText)
        chunks.push(createChunk(paperId, title, paraText, paraOffset, paraOffset + paraText.length))
        buffer = ''
        bufferStart = paraOffset + paraText.length + 2 // +2 for \n\n
        continue
      }

      if (buffer.length + paraText.length > TARGET_CHUNK_SIZE && buffer.trim()) {
        chunks.push(createChunk(paperId, title, buffer.trim(), bufferStart, bufferStart + buffer.length))
        // 保留最后一段作为重叠
        const lastPara = buffer.split(/\n\n+/).pop() || ''
        buffer = lastPara ? lastPara + '\n\n' + paraText + '\n\n' : paraText + '\n\n'
        bufferStart = bufferStart + buffer.length - lastPara.length
      } else {
        buffer += paraText + '\n\n'
      }
    }

    // 刷新剩余缓冲区
    if (buffer.trim()) {
      chunks.push(createChunk(paperId, title, buffer.trim(), bufferStart, bufferStart + buffer.length))
    }
  }

  return chunks
}

function createChunk(
  paperId: string,
  sectionTitle: string,
  content: string,
  startIndex: number,
  endIndex: number,
): Omit<PaperChunk, 'embedding'> {
  return {
    id: randomUUID(),
    paperId,
    content,
    sectionTitle: sectionTitle || '',
    startIndex,
    endIndex,
  }
}

/**
 * 按 Markdown 标题分割文本
 */
interface Section {
  title: string
  content: string
  startOffset: number
}

function splitByHeadings(markdown: string): Section[] {
  const sections: Section[] = []
  const headingRe = /^(#{1,4})\s+(.+)$/gm
  let lastIndex = 0
  let lastTitle = ''
  let match: RegExpExecArray | null

  while ((match = headingRe.exec(markdown)) !== null) {
    const headingEnd = match.index

    if (headingEnd > lastIndex) {
      sections.push({
        title: lastTitle,
        content: markdown.slice(lastIndex, headingEnd),
        startOffset: lastIndex,
      })
    }

    lastTitle = (match[2] || '').trim()
    lastIndex = headingEnd + match[0].length + 1 // +1 for newline
  }

  // 最后一个节
  if (lastIndex < markdown.length) {
    sections.push({
      title: lastTitle,
      content: markdown.slice(lastIndex),
      startOffset: lastIndex,
    })
  }

  return sections
}
