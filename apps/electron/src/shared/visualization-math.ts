/**
 * 片段内 LaTeX 公式 → MathML。
 *
 * 为什么在宿主侧转、而不是让片段自己加载渲染器：片段跑在 `sandbox="allow-scripts"` 且
 * `default-src 'none'` 的 iframe 里，字体同样被 CSP 拦死（`font-src` 落到 default-src），
 * 所以 KaTeX/MathJax 的字体方案在片段里不可用。转成 MathML 后由 Chromium 原生渲染
 * （macOS 走系统 STIX Two Math，Windows 走 Cambria Math），零额外脚本、零字体、零网络。
 *
 * 只识别显式分隔符：行内 `\(...\)`、独占一行 `\[...\]`。**故意不支持 `$...$`**——片段里
 * 金额（`$5`、`$10 ~ $20`）出现的概率远高于公式，启发式识别一定会误伤。
 *
 * 转换只在「元素文本」上发生：
 * - `<script>` / `<style>` / `<pre>` / `<code>` / `<textarea>` 内部原样保留（代码里的 `\(` 是代码）；
 * - 标签与属性原样保留（属性里没法放标记，公式必须写在元素内容里）；
 * - 渲染失败（LaTeX 语法错）时保留原文，让作者看到自己写错了，而不是静默变成空白。
 */
import katex from 'katex'

export type FragmentMathRenderer = (tex: string, displayMode: boolean) => string | null

/** 片段里唯一被识别的公式分隔符。 */
export function hasFragmentMath(html: string): boolean {
  return html.includes('\\(') || html.includes('\\[')
}

/** 默认渲染器：KaTeX → 纯 MathML（不需要 KaTeX 的 CSS 与字体）。 */
export function renderWithKatex(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode, output: 'mathml', throwOnError: true, strict: 'ignore', trust: false })
  } catch {
    return null
  }
}

const MATH_PATTERN = /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g
const RAW_TEXT_TAGS = new Set(['script', 'style', 'pre', 'code', 'textarea'])
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|([^<]+)/g

export function renderFragmentMath(html: string, render: FragmentMathRenderer = renderWithKatex): string {
  if (!hasFragmentMath(html)) return html
  let output = ''
  let cursor = 0
  let rawTag: string | null = null
  TOKEN_PATTERN.lastIndex = 0
  for (let match = TOKEN_PATTERN.exec(html); match; match = TOKEN_PATTERN.exec(html)) {
    // 正则没匹配到的字符（例如文本里裸的 `<`）原样搬运，避免丢内容。
    if (match.index > cursor) output += copyText(html.slice(cursor, match.index), rawTag, render)
    cursor = match.index + match[0].length
    const [token, closing, tagName, text] = match
    if (text !== undefined) {
      output += rawTag ? text : replaceMath(text, render)
      continue
    }
    output += token
    if (!closing) {
      if (rawTag) continue
      const name = (tagName ?? '').toLowerCase()
      if (RAW_TEXT_TAGS.has(name)) rawTag = name
      continue
    }
    if (rawTag === (tagName ?? '').toLowerCase()) rawTag = null
  }
  return output + copyText(html.slice(cursor), rawTag, render)
}

function copyText(text: string, rawTag: string | null, render: FragmentMathRenderer): string {
  return rawTag ? text : replaceMath(text, render)
}

function replaceMath(text: string, render: FragmentMathRenderer): string {
  if (!hasFragmentMath(text)) return text
  return text.replace(MATH_PATTERN, (source, inlineTex?: string, displayTex?: string) => {
    const tex = inlineTex ?? displayTex ?? ''
    return render(tex, displayTex !== undefined) ?? source
  })
}
