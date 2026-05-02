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

  // 后处理 DOM：raf 确保 DOM 完全渲染后直接设样式，绕过 CSS 优先级
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const apply = () => {
      const rootStyle = getComputedStyle(document.documentElement)
      const muted = rootStyle.getPropertyValue('--muted').trim()
      const mutedFg = rootStyle.getPropertyValue('--muted-foreground').trim()
      const border = rootStyle.getPropertyValue('--border').trim()

      // 行号 — 不透明深色背景
      container.querySelectorAll<HTMLElement>(
        '.d2h-code-linenumber, .d2h-code-side-linenumber'
      ).forEach((el) => {
        el.style.setProperty('background', `hsl(${muted})`, 'important')
        el.style.setProperty('color', `hsl(${mutedFg})`, 'important')
        el.style.setProperty('border-color', `hsl(${border})`, 'important')
      })

      // 新增行 — 绿色背景
      container.querySelectorAll<HTMLElement>('.d2h-ins').forEach((el) => {
        el.style.setProperty('background', 'rgba(34,197,94,0.1)', 'important')
      })

      // 删除行 — 红色背景
      container.querySelectorAll<HTMLElement>('.d2h-del').forEach((el) => {
        el.style.setProperty('background', 'rgba(239,68,68,0.1)', 'important')
      })

      // 新增行代码文字颜色
      container.querySelectorAll<HTMLElement>(
        '.d2h-ins .d2h-code-line-ctn'
      ).forEach((el) => {
        el.style.setProperty('color', 'rgb(34,197,94)', 'important')
      })

      // 删除行代码文字颜色
      container.querySelectorAll<HTMLElement>(
        '.d2h-del .d2h-code-line-ctn'
      ).forEach((el) => {
        el.style.setProperty('color', 'rgb(239,68,68)', 'important')
      })
    }

    // requestAnimationFrame 确保 DOM 已完全渲染
    const raf = requestAnimationFrame(apply)
    return () => cancelAnimationFrame(raf)
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
