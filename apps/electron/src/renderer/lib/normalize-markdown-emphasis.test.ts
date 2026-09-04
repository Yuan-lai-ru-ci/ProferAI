import { describe, expect, test } from 'bun:test'
import { normalizeMarkdownEmphasisWhitespace } from './normalize-markdown-emphasis'

describe('normalizeMarkdownEmphasisWhitespace', () => {
  test('removes boundary spaces inside bold markers', () => {
    expect(normalizeMarkdownEmphasisWhitespace('> **完成（Done）和可信度（Assurance） **是两条独立状态轴'))
      .toBe('> **完成（Done）和可信度（Assurance）**是两条独立状态轴')
    expect(normalizeMarkdownEmphasisWhitespace('** 前导空格也应修复**'))
      .toBe('**前导空格也应修复**')
    expect(normalizeMarkdownEmphasisWhitespace('__重要内容 __ 后续说明'))
      .toBe('__重要内容__ 后续说明')
  })

  test('removes trailing spaces inside italic markers', () => {
    expect(normalizeMarkdownEmphasisWhitespace('*重点内容 *与普通文本'))
      .toBe('*重点内容*与普通文本')
    expect(normalizeMarkdownEmphasisWhitespace('_emphasis _ followed by text'))
      .toBe('_emphasis_ followed by text')
  })

  test('keeps valid, unmatched, and escaped markers unchanged', () => {
    expect(normalizeMarkdownEmphasisWhitespace('**已经正确** 和 *也是正确*'))
      .toBe('**已经正确** 和 *也是正确*')
    expect(normalizeMarkdownEmphasisWhitespace('**没有闭合 '))
      .toBe('**没有闭合 ')
    expect(normalizeMarkdownEmphasisWhitespace('\\*literal *'))
      .toBe('\\*literal *')
  })

  test('does not rewrite inline or fenced code', () => {
    const markdown = [
      '`**代码 **` 与 **正常文本 **',
      '```markdown',
      '*代码内容 *',
      '```',
      '',
      '_普通文本 _',
    ].join('\n')

    expect(normalizeMarkdownEmphasisWhitespace(markdown)).toBe([
      '`**代码 **` 与 **正常文本**',
      '```markdown',
      '*代码内容 *',
      '```',
      '',
      '_普通文本_',
    ].join('\n'))
  })
})
