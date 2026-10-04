/**
 * 片段公式渲染（LaTeX → MathML）契约。
 *
 * 覆盖三件事：只有显式分隔符才转换、代码/属性/注释里的反斜杠不动、生成的标记不依赖
 * 字体或网络（片段 iframe 的 CSP 把这两样都封死了）。
 */
import { describe, expect, test } from 'bun:test'
import type { VisualizationContent } from '@profer/shared'
import { buildVisualizationExport } from './visualization-export'
import { hasFragmentMath, renderFragmentMath, renderWithKatex } from '../../shared/visualization-math'
import { buildVisualizationSrcDoc } from '../../renderer/lib/visualization-bridge'

const INLINE_OPEN = '\\('
const INLINE_CLOSE = '\\)'
const DISPLAY_OPEN = '\\['
const DISPLAY_CLOSE = '\\]'
const identity = { token: 'token-1', revision: 'r1', generation: 'gen-1', theme: {}, fontFamily: 'system-ui' }

const mathContent: VisualizationContent = {
  html: '<p>公式 \\(E = mc^2\\)</p>',
  record: {
    schemaVersion: 1,
    id: 'viz-math',
    sessionId: 'session-math',
    toolCallId: 'tool-math',
    title: '公式',
    kind: 'structure',
    revision: 'r1',
    recordVersion: 1,
    summary: '公式示例',
    objects: [],
    createdAt: 1,
    updatedAt: 1,
  },
}

describe('fragment math（LaTeX → MathML）', () => {
  test('行内与块级公式都转成 MathML，并保留原始 TeX', () => {
    const html = `<p>复杂度是 ${INLINE_OPEN}O(n\\log n)${INLINE_CLOSE} 级别</p><p>${DISPLAY_OPEN}\\frac{a}{b} = \\sqrt{x}${DISPLAY_CLOSE}</p>`
    const output = renderFragmentMath(html)
    expect(output.match(/<math /g)).toHaveLength(2)
    expect(output).toContain('display="block"')
    expect(output).toContain('<annotation encoding="application/x-tex">O(n\\log n)</annotation>')
    expect(output).toContain('<msqrt>')
    expect(output).toContain('复杂度是 ')
    expect(output).toContain(' 级别')
    expect(output).not.toContain(INLINE_OPEN)
  })

  test('生成标记不引入字体、外链或脚本，符合片段 CSP', () => {
    const output = renderWithKatex('\\sum_{i=1}^{n} i^2', true) ?? ''
    expect(output.startsWith('<span class="katex"><math')).toBe(true)
    // 唯一的 URL 是 MathML 命名空间；不能出现字体、样式表、脚本或外部资源。
    expect(output).not.toMatch(/@font-face|url\(|<link|<script|<img|katex\.min\.css/i)
    expect(output).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
  })

  test('$...$ 不转换（金额与公式无法区分）', () => {
    const html = '<p>成本 $5，售价 $10 ~ $20，写成 $x^2$ 也不转</p>'
    expect(renderFragmentMath(html)).toBe(html)
  })

  test('代码块、样式、脚本与注释里的反斜杠不动', () => {
    const html = [
      '<pre><code>const re = /\\(/g  // \\(x\\) 是文本</code></pre>',
      '<style>/* \\[not math\\] */ b{color:red}</style>',
      '<script>const s = "\\(x\\)"; const t = /\\(/;</script>',
      '<!-- \\(注释里的公式\\) -->',
      '<p>\\(a+b\\)</p>',
    ].join('')
    const output = renderFragmentMath(html)
    expect(output.match(/<math /g)).toHaveLength(1)
    expect(output).toContain('const re = /\\(/g')
    expect(output).toContain('/* \\[not math\\] */')
    expect(output).toContain('const s = "\\(x\\)"')
    expect(output).toContain('<!-- \\(注释里的公式\\) -->')
  })

  test('属性与转义过的反斜杠不参与转换', () => {
    const html = '<p title="\\(x\\)" aria-label="\\[y\\]">值 \\\\(z\\\\) 原样</p>'
    expect(renderFragmentMath(html)).toBe(html)
  })

  test('LaTeX 语法错误时保留原文，不产出空白', () => {
    expect(renderWithKatex('\\frac{', false)).toBeNull()
    const broken = `<p>${INLINE_OPEN}\\frac{${INLINE_CLOSE}</p>`
    expect(renderFragmentMath(broken)).toBe(broken)
  })

  test('没有分隔符时原样返回（快速路径），裸 < 不丢字符', () => {
    const plain = '<p>a < b && c</p>'
    expect(hasFragmentMath(plain)).toBe(false)
    expect(renderFragmentMath(plain)).toBe(plain)
    const mixed = renderFragmentMath(`<p>5 < 6 与 ${INLINE_OPEN}x${INLINE_CLOSE}</p>`)
    expect(mixed).toContain('5 < 6 与 ')
    expect(mixed).toContain('<math ')
  })

  test('srcdoc 与离线导出的片段都能渲染公式', () => {
    const srcDoc = buildVisualizationSrcDoc(mathContent, identity)
    expect(srcDoc).toContain('<math ')
    expect(srcDoc).toContain('E = mc^2')

    const exported = buildVisualizationExport(mathContent, {})
    expect(exported).toContain('<math ')
    expect(exported).toContain('</html>')
  })
})
