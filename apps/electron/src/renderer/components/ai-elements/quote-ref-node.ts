import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { QuoteRefChipView } from './quote-ref-chip'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import { describeQuoteChipDetail, describeQuoteChipLabel } from '@/lib/quoted-selection'

/**
 * 内联引用节点（`[n] 文件名` 胶囊）。
 *
 * 设计：
 * - 引用内容整体存在节点属性里（序列化成 `data-quote`），编辑器文档即唯一真源，
 *   不再需要额外的「引用池」atom 与两套状态同步。
 * - 编号 `n` 由插件在每次 doc 变化后重排为 1..k（脚注模型，按消息独立）；
 *   因为编号只是渲染用属性，重排不会挪动文档位置。
 * - 序列化成 Markdown 时只留 `[n]`（见 `markdown-rich-text.ts` 的 span 分支），
 *   发送前由 `buildAgentMessagePayload` 按 `ref` 展开成引用块。
 */

export const QUOTE_REF_NODE_NAME = 'quoteRef'

export type QuoteRefPayload = Omit<QuotedSelection, 'ref'>

function encodePayload(payload: QuoteRefPayload): string {
  try {
    return encodeURIComponent(JSON.stringify(payload))
  } catch {
    return ''
  }
}

function decodePayload(raw: string | null): QuoteRefPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as QuoteRefPayload
    if (!parsed || typeof parsed !== 'object' || typeof parsed.text !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

const renumberKey = new PluginKey('quote-ref-renumber')

/**
 * 每次文档变化后把引用编号重排为 1..k。
 *
 * 只改属性、不改结构，所以同一事务里可以安全地多次 setNodeMarkup。
 */
function createRenumberPlugin(): Plugin {
  return new Plugin({
    key: renumberKey,
    appendTransaction: (transactions, _oldState, newState: EditorState) => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null
      const tr = newState.tr
      let index = 0
      let changed = false
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== QUOTE_REF_NODE_NAME) return
        index += 1
        if (node.attrs.n !== index) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, n: index })
          changed = true
        }
      })
      return changed ? tr : null
    },
  })
}

export const QuoteRef = Node.create({
  name: QUOTE_REF_NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  // 不可选中：否则点击胶囊右侧会把节点变成 NodeSelection，下一次按键直接把它替换掉，
  // 表现为「输入文字后引用消失」。删除走 Backspace（光标紧邻时由 ProseMirror 处理）。
  selectable: false,

  addAttributes() {
    return {
      /** 显示编号，由插件维护 */
      n: {
        default: 1,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-quote-n') || '1') || 1,
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-quote-n': String(attrs.n ?? 1) }),
      },
      /** 引用内容（序列化 JSON，避免把长文本摊成多个属性） */
      quote: {
        default: null as QuoteRefPayload | null,
        parseHTML: (el: HTMLElement) => decodePayload(el.getAttribute('data-quote')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const payload = attrs.quote as QuoteRefPayload | null
          return payload ? { 'data-quote': encodePayload(payload) } : {}
        },
      },
    }
  },

  parseHTML() {
    return [{
      tag: 'span[data-quote-ref]',
      // payload 缺失（旧草稿/序列化异常）时不再造一个空壳胶囊：跳过节点，
      // 让 `[n]` 留成普通文本，避免出现「[2] 引用」这种假标签。
      getAttrs: (el: HTMLElement) => (decodePayload(el.getAttribute('data-quote')) ? null : false),
    }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const payload = node.attrs.quote as QuoteRefPayload | null
    const n = Number(node.attrs.n) || 1
    const label = payload ? describeQuoteChipLabel(payload) : ''
    const excerpt = payload?.text.replace(/\s+/g, ' ').trim() ?? ''
    return [
      'span',
      // 必须透传 HTMLAttributes：`data-quote` / `data-quote-n` 由属性级 renderHTML 产出，
      // 不铺开就会丢 payload，草稿还原后胶囊退化成空壳。
      mergeAttributes(HTMLAttributes, {
        'data-quote-ref': '',
        class: 'quote-ref-chip',
        'data-quote-n': String(n),
        title: payload
          ? `${describeQuoteChipDetail(payload)}\n${excerpt.length > 160 ? `${excerpt.slice(0, 160)}…` : excerpt}`
          : undefined,
      }),
      `[${n}] ${label}`.trim(),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(QuoteRefChipView)
  },

  addProseMirrorPlugins() {
    return [createRenumberPlugin()]
  },
})
