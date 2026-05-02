/**
 * DiffView — diff2html 渲染组件
 *
 * 接收 unified diff 文本，使用 diff2html 渲染为 HTML，
 * 支持 split（side-by-side）和 unified（line-by-line）两种视图。
 */

import * as React from 'react'
import { html as diff2htmlHtml } from 'diff2html'

// diff2html 基础样式（行号、红绿标记等）
import 'diff2html/bundles/css/diff2html.min.css'
// 主题适配覆盖
import './diff-view.css'

interface DiffViewProps {
  /** Unified diff 文本 */
  diffContent: string
  /** 视图模式 */
  viewMode: 'split' | 'unified'
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
      <div
        className="diff-view-container"
        dangerouslySetInnerHTML={{ __html: diffHtml }}
      />
    </div>
  )
}
