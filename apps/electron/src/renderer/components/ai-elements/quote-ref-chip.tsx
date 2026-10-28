import * as React from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'

import { describeQuoteChipDetail, describeQuoteChipLabel } from '@/lib/quoted-selection'
import type { QuoteRefPayload } from './quote-ref-node'

/**
 * 引用胶囊的显示组件（TipTap nodeView）。
 *
 * 只承担「指代」：编号 + 一个来源短词。来源细节（路径/行号/角色 + 摘录）全部放 hover，
 * 不占正文宽度——这是上一版把「历史 · Agent 历史 · Agent 回复」塞进正文后被否掉的原因。
 *
 * 用 nodeView 而不是纯字符串渲染，是为了让编号块、分隔线、省略号都有独立元素可控，
 * 同时给后续「点击回跳原文」留出挂入口的位置。
 */
export function QuoteRefChipView({ node }: NodeViewProps): React.ReactElement {
  const payload = node.attrs.quote as QuoteRefPayload | null
  const n = Number(node.attrs.n) || 1
  const label = payload ? describeQuoteChipLabel(payload) : ''
  const excerpt = payload?.text.replace(/\s+/g, ' ').trim() ?? ''
  const title = payload
    ? `${describeQuoteChipDetail(payload)}\n${excerpt.length > 160 ? `${excerpt.slice(0, 160)}…` : excerpt}`
    : '引用来源已失效'

  return (
    <NodeViewWrapper
      as="span"
      className="quote-ref-chip"
      data-quote-ref=""
      data-quote-n={n}
      title={title}
      contentEditable={false}
    >
      <span className="quote-ref-chip__n">{n}</span>
      {label ? <span className="quote-ref-chip__sep" aria-hidden="true" /> : null}
      {label ? <span className="quote-ref-chip__label">{label}</span> : null}
    </NodeViewWrapper>
  )
}
