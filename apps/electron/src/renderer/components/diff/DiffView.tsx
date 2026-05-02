/**
 * DiffView — diff2html 渲染组件
 *
 * 接收 unified diff 文本，使用 diff2html 渲染为 HTML，
 * 支持 split（side-by-side）和 unified（line-by-line）两种视图。
 * 样式通过注入 <style> 标签 + !important 保证覆盖 diff2html 默认样式。
 */

import * as React from 'react'
import { html as diff2htmlHtml } from 'diff2html'

import 'diff2html/bundles/css/diff2html.min.css'

interface DiffViewProps {
  diffContent: string
  viewMode: 'split' | 'unified'
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
    }

    /* 行号在统一视图中 */
    .diff-view-container .d2h-code-linenumber {
      background: hsl(${muted}) !important;
      border-color: hsl(${border}) !important;
      color: hsl(${mutedFg}) !important;
    }

    /* 行号在分栏视图中 */
    .diff-view-container .d2h-code-side-linenumber {
      background: hsl(${muted}) !important;
      border-color: hsl(${border}) !important;
      color: hsl(${mutedFg}) !important;
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
      background: rgba(34,197,94,0.1) !important;
    }
    .diff-view-container .d2h-ins .d2h-code-line-ctn {
      color: rgb(34,197,94) !important;
    }

    /* 删除行 */
    .diff-view-container .d2h-del {
      background: rgba(239,68,68,0.1) !important;
    }
    .diff-view-container .d2h-del .d2h-code-line-ctn {
      color: rgb(239,68,68) !important;
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
  `
}

export function DiffView({ diffContent, viewMode }: DiffViewProps): React.ReactElement {
  const outputFormat = viewMode === 'split' ? 'side-by-side' : 'line-by-line'
  const containerRef = React.useRef<HTMLDivElement>(null)

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

  if (!diffHtml) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">
        暂无差异内容
      </div>
    )
  }

  return (
    <div ref={containerRef} className="diff-view-wrapper h-full overflow-auto">
      <style dangerouslySetInnerHTML={{ __html: buildStyleTag() }} />
      <div
        className="diff-view-container"
        dangerouslySetInnerHTML={{ __html: diffHtml }}
      />
    </div>
  )
}
