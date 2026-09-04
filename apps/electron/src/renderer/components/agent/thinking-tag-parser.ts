import type { SDKContentBlock, SDKTextBlock } from '@profer/shared'

const THINK_TAG_NAMES = ['think', 'thinking'] as const

type ThinkTagName = (typeof THINK_TAG_NAMES)[number]

function findNextThinkOpenTag(text: string, cursor: number): { index: number; tagName: ThinkTagName } | null {
  let match: { index: number; tagName: ThinkTagName } | null = null
  for (const tagName of THINK_TAG_NAMES) {
    const index = text.indexOf(`<${tagName}>`, cursor)
    if (index !== -1 && (!match || index < match.index)) {
      match = { index, tagName }
    }
  }
  return match
}

function containsThinkOpenTag(text: string): boolean {
  return THINK_TAG_NAMES.some((tagName) => text.includes(`<${tagName}>`))
}

function appendTextBlock(blocks: SDKContentBlock[], text: string): void {
  if (!text.trim()) return
  blocks.push({ type: 'text', text })
}

function appendThinkingBlock(blocks: SDKContentBlock[], thinking: string): void {
  const content = thinking.trim()
  if (!content) return
  blocks.push({ type: 'thinking', thinking: content })
}

/**
 * 兼容部分模型把思考内容包在 <think> 或 <thinking> 标签里的返回格式。
 * 未闭合的标签在流式阶段按思考块处理，等闭合标签到达后会自然拆出后续正文。
 */
export interface ThinkTagParserOptions {
  /**
   * 已落定的消息中，模型偶尔只输出 `<thinking>` 开标签而遗漏闭标签。
   * 此时将标签后的内容作为正文显示，避免最终交付被错误折叠进思考区。
   * 流式阶段保持默认值 false，仍把未闭合标签视为进行中的思考。
   */
  unclosedTagAsText?: boolean
}

export function parseThinkTagsFromText(text: string, options: ThinkTagParserOptions = {}): SDKContentBlock[] {
  const lowerText = text.toLowerCase()
  const blocks: SDKContentBlock[] = []
  let cursor = 0

  while (cursor < text.length) {
    const openTag = findNextThinkOpenTag(lowerText, cursor)
    if (!openTag) {
      appendTextBlock(blocks, text.slice(cursor))
      break
    }

    appendTextBlock(blocks, text.slice(cursor, openTag.index))

    const openTagText = `<${openTag.tagName}>`
    const closeTagText = `</${openTag.tagName}>`
    const contentStart = openTag.index + openTagText.length
    const closeIndex = lowerText.indexOf(closeTagText, contentStart)
    if (closeIndex === -1) {
      if (options.unclosedTagAsText) {
        appendTextBlock(blocks, text.slice(contentStart))
      } else {
        appendThinkingBlock(blocks, text.slice(contentStart))
      }
      break
    }

    appendThinkingBlock(blocks, text.slice(contentStart, closeIndex))
    cursor = closeIndex + closeTagText.length
  }

  return blocks
}

export function splitThinkTagsInTextBlock(block: SDKTextBlock, options?: ThinkTagParserOptions): SDKContentBlock[] {
  if (!containsThinkOpenTag(block.text.toLowerCase())) return [block]
  return parseThinkTagsFromText(block.text, options)
}

export function normalizeThinkTagsInContentBlocks(
  blocks: SDKContentBlock[],
  options?: ThinkTagParserOptions,
): SDKContentBlock[] {
  const normalized: SDKContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      normalized.push(...splitThinkTagsInTextBlock(block as SDKTextBlock, options))
    } else {
      normalized.push(block)
    }
  }
  return normalized
}
