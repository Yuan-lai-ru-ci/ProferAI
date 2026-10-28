import * as React from 'react'

import type { QuotedSelection } from '@/atoms/preview-atoms'

/**
 * 原文侧引用高亮（草稿期）。
 *
 * 引用落进输入框后，来源消息里的那段文字要高亮出来——否则用户只看到输入框里的
 * `[1]`，回不到「我到底引了哪一段」。实现走 CSS Custom Highlight API：
 * 不修改 DOM，因此不会和 React 的渲染、以及历史消息的增量更新打架。
 *
 * 生命周期跟着引用走：引用被删/消息发出后编辑器清空，高亮随之消失（不做常驻批注）。
 */

const HIGHLIGHT_NAME = 'profer-quote-source'

interface HighlightLike {
  add(range: Range): void
}

interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void
  delete(name: string): void
}

interface HighlightCapableWindow {
  Highlight?: new () => HighlightLike
}

/**
 * 把 `raw` 规范化成「空白折叠成单空格」的文本，并记录每个规范化字符对应的原文下标。
 * 选区文本在捕获时已做同样的规范化，所以两边可以直接对齐。
 */
function normalizeWithMap(raw: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (/\s/.test(char)) {
      if (text.length === 0 || text.endsWith(' ')) continue
      text += ' '
      map.push(index)
      continue
    }
    text += char
    map.push(index)
  }
  return { text, map }
}

function matchInNode(node: Node, needle: string): Range | null {
  const raw = node.textContent ?? ''
  if (!raw.trim()) return null
  const { text, map } = normalizeWithMap(raw)
  const hit = needle ? text.indexOf(needle) : -1
  if (hit < 0) return null
  const start = map[hit]
  const end = map[hit + needle.length - 1]
  if (typeof start !== 'number' || typeof end !== 'number') return null
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end + 1)
  return range
}

/**
 * 在容器里按文本找到选区对应的 Range；找不到返回 null（调用方静默跳过）。
 *
 * 跨段落的选区按「前缀」兜底：整段文本不会落在同一个 text node 里，
 * 退一步只高亮开头那段，比完全不高亮更有用。
 */
export function findQuoteRange(container: Element, quoteText: string): Range | null {
  const needle = normalizeWithMap(quoteText).text.trim()
  if (!needle) return null

  const nodes: Node[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node)

  for (const node of nodes) {
    const range = matchInNode(node, needle)
    if (range) return range
  }

  const prefix = needle.slice(0, 40).trim()
  if (prefix.length < 4 || prefix === needle) return null
  for (const node of nodes) {
    const range = matchInNode(node, prefix)
    if (range) return range
  }
  return null
}

function resolveRegistry(): HighlightRegistryLike | null {
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights
  return registry && typeof registry.set === 'function' ? registry : null
}

/**
 * 把当前草稿里的引用在来源消息上高亮。
 *
 * @param sessionId 会话 id，用于把查找范围限制在本会话的消息容器内
 * @param version   任意会在引用变化时改变的值（这里用输入框 HTML），用于触发重算
 * @param getQuotes 读取当前引用（含 messageId 的才能高亮）
 */
export function useQuoteSourceHighlight(
  sessionId: string,
  version: string,
  getQuotes: () => QuotedSelection[],
): void {
  const getQuotesRef = React.useRef(getQuotes)
  getQuotesRef.current = getQuotes

  React.useEffect(() => {
    const registry = resolveRegistry()
    const HighlightCtor = (window as unknown as HighlightCapableWindow).Highlight
    if (!registry || !HighlightCtor) return

    let cancelled = false

    const apply = (): void => {
      if (cancelled) return
      const highlight = new HighlightCtor()
      const quotes = getQuotesRef.current()
      if (quotes.length > 0) {
        const scope: Element = document.querySelector(`[data-agent-session-id="${CSS.escape(sessionId)}"]`) ?? document.body
        for (const quote of quotes) {
          if (!quote.text) continue
          // 优先在来源消息里找；跨消息选区没有 messageId、或消息被虚拟滚动换掉时，
          // 退化为在整个会话里找这段文字——宁可标到唯一出现处，也不要整段不标。
          const candidates: Element[] = []
          if (quote.messageId) {
            // 历史消息的 id 既可能是 message id，也可能是 fork id（分叉消息只带后者）
            const escaped = CSS.escape(quote.messageId)
            const container = scope.querySelector(
              `[data-message-id="${escaped}"], [data-message-fork-id="${escaped}"]`,
            )
            if (container) candidates.push(container)
          }
          candidates.push(scope)
          for (const container of candidates) {
            const range = findQuoteRange(container, quote.text)
            if (!range) continue
            highlight.add(range)
            break
          }
        }
      }
      registry.set(HIGHLIGHT_NAME, highlight)
    }

    apply()

    // 消息列表/历史窗口常常晚于引用状态一拍才渲染完：补两次重算，避免「只有一条标上」。
    const retryTimers = [120, 400].map((ms) => window.setTimeout(apply, ms))

    // 虚拟滚动/折叠会替换 DOM 节点，滚动后按 150ms 防抖重算一次（底色是文本级样式，不会抖动）
    let scrollTimer: number | null = null
    const onViewportChange = (): void => {
      if (scrollTimer !== null) return
      scrollTimer = window.setTimeout(() => {
        scrollTimer = null
        apply()
      }, 150)
    }
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)

    return () => {
      cancelled = true
      for (const timer of retryTimers) window.clearTimeout(timer)
      if (scrollTimer !== null) window.clearTimeout(scrollTimer)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
      registry.delete(HIGHLIGHT_NAME)
    }
  }, [sessionId, version])
}
