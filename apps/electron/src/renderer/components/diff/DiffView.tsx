/**
 * DiffView — diff2html 渲染组件
 *
 * 接收 unified diff 文本，使用 diff2html 渲染为 HTML，
 * 支持 split（side-by-side）和 unified（line-by-line）两种视图。
 * 样式通过注入 <style> 标签 + !important 保证覆盖 diff2html 默认样式。
 */

import * as React from 'react'
import { html as diff2htmlHtml } from 'diff2html'
import { useAtomValue } from 'jotai'
import { resolvedThemeAtom } from '@/atoms/theme'
import { highlightToTokens, highlightCode } from '@proma/core'

import 'diff2html/bundles/css/diff2html.min.css'

interface DiffViewProps {
  diffContent: string
  viewMode: 'split' | 'unified'
  /** 文件路径（用于语法高亮的语言推断） */
  filePath?: string
}

/** 根据文件扩展名推断语言 */
function inferLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    md: 'markdown', html: 'html', css: 'css',
    sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
    sql: 'sql', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
    kt: 'kotlin', swift: 'swift',
  }
  return map[ext] || 'text'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 用 token 数组生成带颜色的 HTML */
function tokensToHtml(tokens: Array<{ content: string; color?: string }>): string {
  return tokens
    .map((t) =>
      t.color
        ? `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`
        : escapeHtml(t.content),
    )
    .join('')
}

function buildStyleTag(): string {
  // 从 :root 拿当前主题颜色，生成带 !important 的样式
  const s = getComputedStyle(document.documentElement)
  const bg = s.getPropertyValue('--background').trim()
  const border = s.getPropertyValue('--border').trim()
  const muted = s.getPropertyValue('--muted').trim()
  const mutedFg = s.getPropertyValue('--muted-foreground').trim()
  const fg = s.getPropertyValue('--foreground').trim()

  return `
    /* 行号背景 — 深色不透明方块 */
    .diff-view-container .d2h-code-linenumber,
    .diff-view-container .d2h-code-side-linenumber {
      background: hsl(${muted}) !important;
      border-color: hsl(${border}) !important;
      color: hsl(${mutedFg}) !important;
      position: relative !important;
      float: none !important;
    }

    /* 行号在统一视图中 */
    .diff-view-container .d2h-code-linenumber {
      background: hsl(${muted}) !important;
      border-color: hsl(${border}) !important;
      color: hsl(${mutedFg}) !important;
      position: relative !important;
      float: none !important;
    }

    /* 行号在分栏视图中 */
    .diff-view-container .d2h-code-side-linenumber {
      background: hsl(${muted}) !important;
      border-color: hsl(${border}) !important;
      color: hsl(${mutedFg}) !important;
      position: relative !important;
      float: none !important;
    }

    /* 深色模式下的行号 — 覆盖 .d2h-dark-color-scheme */
    .diff-view-container .d2h-code-linenumber,
    .diff-view-container .d2h-code-side-linenumber {
      background: hsl(${muted}) !important;
      border-color: hsl(${border}) !important;
      color: hsl(${mutedFg}) !important;
    }

    /* 新增行 */
    .diff-view-container .d2h-ins {
      background: rgba(34,197,94,0.08) !important;
    }
    .diff-view-container .d2h-ins .d2h-code-line-ctn {
      color: rgb(22,163,74) !important;
    }

    /* 删除行 */
    .diff-view-container .d2h-del {
      background: rgba(239,68,68,0.08) !important;
    }
    .diff-view-container .d2h-del .d2h-code-line-ctn {
      color: rgb(220,38,38) !important;
    }

    /* 代码行背景透明 */
    .diff-view-container .d2h-code-line {
      background: transparent !important;
    }

    /* 表格/容器背景 */
    .diff-view-container .d2h-wrapper {
      background: hsl(${bg}) !important;
      color: hsl(${fg}) !important;
    }

    /* 信息行 */
    .diff-view-container .d2h-info {
      background: hsl(${muted} / 0.3) !important;
      color: hsl(${mutedFg}) !important;
      border-color: hsl(${border}) !important;
    }

    /* 表格边框 */
    .diff-view-container .d2h-diff-table,
    .diff-view-container .d2h-diff-tbody > tr > td {
      border-color: hsl(${border}) !important;
    }
    .diff-view-container .d2h-file-side-diff,
    .diff-view-container .d2h-file-diff {
      border-color: hsl(${border}) !important;
    }

    /* 隐藏 diff2html 的文件 header（避免和顶层路径栏重复） */
    .diff-view-container .d2h-file-header {
      display: none !important;
    }

    /* Hunk header (@@ ... @@) — 隐藏 */
    .diff-view-container .d2h-info {
      display: none !important;
    }

    /* 空白占位格 — 斜条纹覆盖，让行列的红/绿底色透出 */
    .diff-view-container .d2h-code-side-emptyplaceholder,
    .diff-view-container .d2h-emptyplaceholder {
      background-color: transparent !important;
      background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 3px,
        hsl(${border} / 0.35) 3px,
        hsl(${border} / 0.35) 5px
      ) !important;
    }
  `
}

export function DiffView({ diffContent, viewMode, filePath }: DiffViewProps): React.ReactElement {
  const outputFormat = viewMode === 'split' ? 'side-by-side' : 'line-by-line'
  const containerRef = React.useRef<HTMLDivElement>(null)

  // 订阅主题变化以确保样式注入跟随主题更新
  const theme = useAtomValue(resolvedThemeAtom)

  const diffHtml = React.useMemo(() => {
    if (!diffContent) return ''
    try {
      return diff2htmlHtml(diffContent, {
        drawFileList: false,
        matching: 'lines',
        outputFormat,
        renderNothingWhenEmpty: true,
      })
    } catch {
      return ''
    }
  }, [diffContent, outputFormat])

  // 生成主题样式（随 theme 变化重新生成）
  const styleTag = React.useMemo(() => buildStyleTag(), [theme])

  // split 模式下同步左右两侧的水平滚动
  React.useEffect(() => {
    if (viewMode !== 'split') return
    const container = containerRef.current
    if (!container) return

    const sideDiffs = container.querySelectorAll<HTMLElement>('.d2h-file-side-diff')
    const sync = (source: HTMLElement) => {
      const sl = source.scrollLeft
      sideDiffs.forEach((el) => {
        if (el !== source && el.scrollLeft !== sl) el.scrollLeft = sl
      })
    }

    const handlers: Array<{ el: HTMLElement; fn: () => void }> = []
    sideDiffs.forEach((el) => {
      const fn = () => sync(el)
      el.addEventListener('scroll', fn, { passive: true })
      handlers.push({ el, fn })
    })

    return () => {
      handlers.forEach(({ el, fn }) => el.removeEventListener('scroll', fn))
    }
  }, [diffHtml, viewMode])

  // 语法高亮后处理 — 逐行 tokenize（确保对齐，避免混合代码上下文错乱）
  React.useEffect(() => {
    const container = containerRef.current
    if (!container || !filePath) return

    const lang = inferLang(filePath)
    if (lang === 'text') return

    const themeName = theme === 'light' ? 'github-light' : 'github-dark'

    const raf = requestAnimationFrame(async () => {
      const allCtn = container.querySelectorAll<HTMLElement>('.d2h-code-line-ctn')

      // 先用空调用初始化 Shiki（如果还没初始化）
      let test = highlightToTokens({ code: ' ', language: lang, theme: themeName })
      if (!test) {
        await highlightCode({ code: ' ', language: lang, theme: themeName })
        test = highlightToTokens({ code: ' ', language: lang, theme: themeName })
      }
      if (!test) return // Shiki 仍然不可用，放弃

      // 逐行处理
      allCtn.forEach((el) => {
        const text = (el.textContent || '').replace(/​/g, '')
        if (!text.trim()) return // 跳过空行/占位格
        try {
          const tokens = highlightToTokens({ code: text, language: lang, theme: themeName })
          if (tokens && tokens.lines[0]) {
            el.innerHTML = tokensToHtml(tokens.lines[0])
          }
        } catch {
          // 单行 tokenize 失败，保留原文
        }
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [diffHtml, filePath, theme])

  if (!diffHtml) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">
        暂无差异内容
      </div>
    )
  }

  return (
    <div ref={containerRef} className="diff-view-wrapper h-full overflow-auto">
      <style dangerouslySetInnerHTML={{ __html: styleTag }} />
      <div
        className="diff-view-container"
        dangerouslySetInnerHTML={{ __html: diffHtml }}
      />
    </div>
  )
}
