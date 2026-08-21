/**
 * 修复模型偶尔在 Markdown 强调标记内部加入的边界空格。
 *
 * CommonMark 不会将 `**文字 **` 或 `*文字 *` 解析为强调，用户会直接看到标记。
 * 此处只移除紧贴开、闭标记的空格；围栏代码块和行内代码保持字面量不变。
 */

const STRONG_WITH_BOUNDARY_SPACE = /(^|[^\\*_])(\*{2,3}|_{2,3})(?![*_])([ \t]*)(\S(?:[^\r\n]*?\S)?)([ \t]*)(\2)(?![*_])/gm
const EMPHASIS_WITH_BOUNDARY_SPACE = /(^|[^\\*_])([*_])(?![*_])([ \t]*)(\S(?:[^\r\n]*?\S)?)([ \t]*)(\2)(?![*_])/gm

function removeEmphasisBoundaryWhitespace(
  _match: string,
  prefix: string,
  marker: string,
  leadingWhitespace: string,
  content: string,
  trailingWhitespace: string,
  closingMarker: string
): string {
  // 仅在至少一侧有误空格时重写，合法 Markdown 保持原样。
  if (!leadingWhitespace && !trailingWhitespace) return _match
  return `${prefix}${marker}${content}${closingMarker}`
}

function normalizePlainMarkdownText(text: string): string {
  return text
    .replace(STRONG_WITH_BOUNDARY_SPACE, removeEmphasisBoundaryWhitespace)
    .replace(EMPHASIS_WITH_BOUNDARY_SPACE, removeEmphasisBoundaryWhitespace)
}

function countRun(text: string, start: number, character: string): number {
  let end = start
  while (text[end] === character) end++
  return end - start
}

function findMatchingBacktickRun(text: string, start: number, length: number): number {
  const delimiter = '`'.repeat(length)
  let candidate = text.indexOf(delimiter, start)

  while (candidate !== -1) {
    if (countRun(text, candidate, '`') === length) return candidate
    candidate = text.indexOf(delimiter, candidate + length)
  }

  return -1
}

function findClosingFence(text: string, searchFrom: number, fenceCharacter: string, length: number): number {
  const lineStart = /(?:^|\n)[ \t]{0,3}/g
  lineStart.lastIndex = searchFrom

  let match: RegExpExecArray | null
  while ((match = lineStart.exec(text)) !== null) {
    const fenceStart = lineStart.lastIndex
    if (countRun(text, fenceStart, fenceCharacter) >= length) {
      const lineEnd = text.indexOf('\n', fenceStart)
      return lineEnd === -1 ? text.length : lineEnd + 1
    }
  }

  return -1
}

/**
 * 在 Markdown 解析前规范化强调标记。
 *
 * 仅处理具备配对闭合标记的 `*` / `_` 强调；未闭合或已经合法的文本不会改变。
 */
export function normalizeMarkdownEmphasisWhitespace(text: string): string {
  // 快速跳过没有强调标记的纯文本；完整边界匹配留给下方正则完成。
  if (!text || !/[\*_]/.test(text)) return text

  let normalized = ''
  let plainTextStart = 0
  let index = 0

  const appendProtected = (end: number): void => {
    normalized += normalizePlainMarkdownText(text.slice(plainTextStart, index))
    normalized += text.slice(index, end)
    plainTextStart = end
    index = end
  }

  while (index < text.length) {
    const atLineStart = index === 0 || text[index - 1] === '\n'
    const fenceMatch = atLineStart ? text.slice(index).match(/^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/) : null
    if (fenceMatch) {
      const fence = fenceMatch[1]!
      const fenceCharacter = fence[0]!
      const openingEnd = index + fenceMatch[0].length
      const closingEnd = findClosingFence(text, openingEnd, fenceCharacter, fence.length)
      appendProtected(closingEnd === -1 ? text.length : closingEnd)
      continue
    }

    if (text[index] === '`') {
      const length = countRun(text, index, '`')
      const closingStart = findMatchingBacktickRun(text, index + length, length)
      if (closingStart !== -1) {
        appendProtected(closingStart + length)
        continue
      }
    }

    index++
  }

  normalized += normalizePlainMarkdownText(text.slice(plainTextStart))
  return normalized
}
