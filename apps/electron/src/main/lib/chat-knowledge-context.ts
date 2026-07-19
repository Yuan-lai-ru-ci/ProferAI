import type { KnowledgeReference, KnowledgeSearchResult } from '@profer/shared'

export interface KnowledgeSearchPort {
  (query: string, allowedItemIds: string[], options: { topK: number; maxChars: number }): Promise<KnowledgeSearchResult[]>
}

/** Chat 发送时的资料库上下文硬上限，防止引用变相成为全文注入。 */
const MAX_RESULTS = 6
const MAX_CHARS = 6_000

export async function buildChatKnowledgeContext(
  query: string,
  references: KnowledgeReference[] | undefined,
  search: KnowledgeSearchPort,
): Promise<string> {
  const normalizedQuery = query.trim()
  const allowedItemIds = [...new Set((references || []).map((reference) => reference.itemId).filter(Boolean))]
  if (!normalizedQuery || allowedItemIds.length === 0) return ''

  const results = await search(normalizedQuery, allowedItemIds, { topK: MAX_RESULTS, maxChars: MAX_CHARS })
  if (!results.length) return ''

  const sources = results.map((result) => {
    const content = result.content.slice(0, MAX_CHARS).trim()
    if (!content) return ''
    return `<source item_id="${result.item.id}" title="${escapeAttribute(result.item.title)}" kind="${result.item.kind}">\n${content}\n</source>`
  }).filter(Boolean)
  return sources.length ? `\n\n<knowledge_context>\n${sources.join('\n')}\n</knowledge_context>` : ''
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
