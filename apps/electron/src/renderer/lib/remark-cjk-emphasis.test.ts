import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normalizeMarkdownEmphasisWhitespace } from './normalize-markdown-emphasis'
import { remarkCjkEmphasis } from './remark-cjk-emphasis'

function render(source: string): string {
  return renderToStaticMarkup(createElement(Markdown, {
    remarkPlugins: [remarkGfm, remarkCjkEmphasis],
    children: normalizeMarkdownEmphasisWhitespace(source),
  }))
}

describe('中文标点强调渲染', () => {
  test.each([
    ['- **子会话还没打开：**从父会话点进去', '<ul>\n<li><strong>子会话还没打开：</strong>从父会话点进去</li>\n</ul>'],
    ['我会把**“父在右屏、子在左屏”**当作首要', '<p>我会把<strong>“父在右屏、子在左屏”</strong>当作首要</p>'],
    ['**子会话已经打开： **无论从侧栏、聚焦', '<p><strong>子会话已经打开：</strong>无论从侧栏、聚焦</p>'],
    ['前**「含 `code` 和 *强调*」**后', '<p>前<strong>「含 <code>code</code> 和 <em>强调</em>」</strong>后</p>'],
    ['前***“重点”***后', '<p>前<em><strong>“重点”</strong></em>后</p>'],
    ['前*“重点”*后', '<p>前<em>“重点”</em>后</p>'],
    ['**标签：**正文与**另一项：**说明', '<p><strong>标签：</strong>正文与<strong>另一项：</strong>说明</p>'],
    ['前**“流式”**后', '<p>前<strong>“流式”</strong>后</p>'],
    ['`**代码：**原样`', '<p><code>**代码：**原样</code></p>'],
    ['```md\n**代码：**原样\n```', '<pre><code class="language-md">**代码：**原样\n</code></pre>'],
    ['\\*\\*“字面量”\\*\\*', '<p>**“字面量”**</p>'],
    ['未完成**“流式', '<p>未完成**“流式</p>'],
    ['**正常** 与 foo_bar_baz 和 *italic*', '<p><strong>正常</strong> 与 foo_bar_baz 和 <em>italic</em></p>'],
  ])('%s', (source, html) => expect(render(source)).toBe(html))
})
