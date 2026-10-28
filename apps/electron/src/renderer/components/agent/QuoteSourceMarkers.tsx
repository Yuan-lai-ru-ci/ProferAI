import * as React from 'react'

import type { QuotedSelection } from '@/atoms/preview-atoms'
import { findQuoteRange } from '@/hooks/useQuoteSourceHighlight'

/**
 * 原文侧「批注栏」标记：引用段落左边一条 2px 竖条 + 顶端编号。
 *
 * 四条硬约束（前几版都栽在这里）：
 * 1. **不抖**：标记层挂进会话的滚动容器，用内容坐标定位，随内容一起滚动，滚动过程零重算。
 * 2. **不丢**：有 messageId 先在该消息里找，没有（跨消息选区）或消息被虚拟滚动换掉时
 *    退化为全会话搜该段文字；晚渲染补两次重算。
 * 3. **不重叠**：同一行（同一文本块 + 同一行顶）上的多条引用合并成一个标记，编号显示 `3·4`，
 *    竖条高度覆盖到该行结束——否则多个标记会压在一起。
 * 4. **贴行首**：竖线水平位置用引用起点所在文本块的左缘，不跟着选区起点跑。
 */

interface MarkerElements {
  bar: HTMLDivElement
  num: HTMLSpanElement
}

interface MarkerGroup {
  refs: number[]
  /** 文本块左缘（行首） */
  left: number
  top: number
  bottom: number
}

const DEDUPE_SEPARATOR = '\u0000'

export interface QuoteSourceMarkersProps {
  sessionId: string
  /** 任意在引用变化时改变的值（输入框 HTML），用于触发重算 */
  version: string
  getQuotes: () => QuotedSelection[]
}

export function QuoteSourceMarkers({ sessionId, version, getQuotes }: QuoteSourceMarkersProps): null {
  const getQuotesRef = React.useRef(getQuotes)
  getQuotesRef.current = getQuotes

  React.useEffect(() => {
    const sessionScope: Element =
      document.querySelector(`[data-agent-session-id="${CSS.escape(sessionId)}"]`) ?? document.body
    const scrollHost = sessionScope.querySelector<HTMLElement>('.profer-scroll-region')
    const host: HTMLElement = scrollHost ?? document.body
    const relativeToContent = Boolean(scrollHost)
    const previousPosition = host.style.position
    if (relativeToContent && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
    }

    const layer = document.createElement('div')
    layer.className = relativeToContent ? 'quote-source-markers quote-source-markers--content' : 'quote-source-markers'
    layer.setAttribute('aria-hidden', 'true')
    host.appendChild(layer)

    const markers = new Map<string, MarkerElements>()

    const resolveRange = (quote: QuotedSelection): Range | null => {
      if (!quote.text) return null
      const candidates: Element[] = []
      if (quote.messageId) {
        const escaped = CSS.escape(quote.messageId)
        const container = sessionScope.querySelector(
          `[data-message-id="${escaped}"], [data-message-fork-id="${escaped}"]`,
        )
        if (container) candidates.push(container)
      }
      candidates.push(sessionScope)
      for (const container of candidates) {
        const range = findQuoteRange(container, quote.text)
        if (range) return range
      }
      return null
    }

    /** 按「文本块 + 行顶」合并：同一行上的多条引用只留一个标记，编号合并成 `3·4`。 */
    const collectGroups = (): Map<string, MarkerGroup> => {
      const groups = new Map<string, MarkerGroup>()
      const blockIds = new Map<Element, number>()
      const seen = new Set<string>()

      for (const quote of getQuotesRef.current()) {
        if (!quote.text) continue
        const dedupeKey = `${quote.messageId ?? ''}${DEDUPE_SEPARATOR}${quote.text}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)

        const range = resolveRange(quote)
        if (!range) continue
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
        if (!rect || rect.height === 0) continue

        const startNode = range.startContainer
        const startEl = startNode.nodeType === Node.ELEMENT_NODE
          ? (startNode as Element)
          : startNode.parentElement
        const blockEl = startEl?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th') ?? null
        let blockId = -1
        if (blockEl) {
          const known = blockIds.get(blockEl)
          if (known === undefined) {
            blockId = blockIds.size
            blockIds.set(blockEl, blockId)
          } else {
            blockId = known
          }
        }
        const blockRect = blockEl?.getBoundingClientRect()
        const anchorLeft = blockRect && blockRect.width > 0 ? blockRect.left : rect.left

        const key = `${blockId}:${Math.round(rect.top)}`
        const existing = groups.get(key)
        if (existing) {
          if (quote.ref !== undefined && !existing.refs.includes(quote.ref)) existing.refs.push(quote.ref)
          existing.top = Math.min(existing.top, rect.top)
          existing.bottom = Math.max(existing.bottom, rect.bottom)
          continue
        }
        groups.set(key, {
          refs: quote.ref !== undefined ? [quote.ref] : [],
          left: anchorLeft,
          top: rect.top,
          bottom: rect.bottom,
        })
      }

      for (const group of groups.values()) group.refs.sort((a, b) => a - b)
      return groups
    }

    const rebuild = (): void => {
      const groups = collectGroups()
      const alive = new Set<string>()
      const hostRect = relativeToContent ? host.getBoundingClientRect() : null

      for (const [key, group] of groups) {
        alive.add(key)
        let marker = markers.get(key)
        if (!marker) {
          const bar = document.createElement('div')
          bar.className = 'quote-source-marker__bar'
          const num = document.createElement('span')
          num.className = 'quote-source-marker__num'
          bar.appendChild(num)
          layer.appendChild(bar)
          marker = { bar, num }
          markers.set(key, marker)
        }

        const left = hostRect ? group.left - hostRect.left + host.scrollLeft : group.left
        const top = hostRect ? group.top - hostRect.top + host.scrollTop : group.top
        marker.bar.style.transform = `translate3d(${Math.round(left - 8)}px, ${Math.round(top)}px, 0)`
        marker.bar.style.height = `${Math.max(14, Math.round(group.bottom - group.top))}px`
        marker.num.textContent = group.refs.length > 0 ? group.refs.join('·') : '1'
        // 左边距够就贴在竖条左侧（宽度自适应），不够则挪到竖条上方，避免压到头像/文字
        const hasGutter = left >= 30
        marker.num.style.right = hasGutter ? '100%' : 'auto'
        marker.num.style.left = hasGutter ? 'auto' : '0px'
        marker.num.style.top = hasGutter ? '-1px' : '-13px'
      }

      for (const [key, marker] of markers) {
        if (alive.has(key)) continue
        marker.bar.remove()
        markers.delete(key)
      }
    }

    rebuild()
    // 历史窗口/虚拟滚动常常晚一拍：补两次重算，避免「只标上一条」
    const retryTimers = [120, 400].map((ms) => window.setTimeout(rebuild, ms))
    window.addEventListener('resize', rebuild)
    // 兜底（宿主退化成 body 时才需要跟随滚动；内容坐标系里滚动无需重算）
    const onScroll = relativeToContent ? null : rebuild
    if (onScroll) window.addEventListener('scroll', onScroll, true)

    return () => {
      for (const timer of retryTimers) window.clearTimeout(timer)
      window.removeEventListener('resize', rebuild)
      if (onScroll) window.removeEventListener('scroll', onScroll, true)
      for (const marker of markers.values()) marker.bar.remove()
      markers.clear()
      layer.remove()
      if (relativeToContent) host.style.position = previousPosition
    }
  }, [sessionId, version])

  return null
}
