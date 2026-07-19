import type { SDKMessage, SDKToolUseBlock } from '@profer/shared'

export interface ReadKnowledgeItem { itemId: string; title: string }

/** 仅从真实 MCP 调用及其成功 tool_result 中提取资料，不信任模型文本自述。 */
export function extractReadKnowledgeItems(messages: SDKMessage[]): ReadKnowledgeItem[] {
  const calls = new Map<string, string[]>()
  const completed = new Set<string>()
  const resultIds = new Map<string, string[]>()
  const titles = new Map<string, string>()

  for (const message of messages) {
    if (message.type === 'assistant') {
      const content = (message as { message: { content: SDKToolUseBlock[] } }).message.content
      for (const block of content) {
        if (block.type !== 'tool_use' || (block as SDKToolUseBlock).name !== 'mcp__knowledge-base__read_imported_knowledge') continue
        const input = (block as SDKToolUseBlock).input as { itemIds?: unknown } | undefined
        const ids = Array.isArray(input?.itemIds) ? input.itemIds.filter((id): id is string => typeof id === 'string') : []
        calls.set((block as SDKToolUseBlock).id, ids)
      }
    }
    if (message.type === 'user') {
      const content = (message as { message: { content: Array<{ type: string; tool_use_id: string; content: unknown }> } }).message.content
      for (const block of content) {
        if (block.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue
        const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (/"unavailable"\s*:\s*true|KNOWLEDGE_ITEM_NOT_IMPORTED/.test(raw)) continue
        try {
          const payload = JSON.parse(raw) as { items?: Array<{ itemId?: string; title?: string }>; results?: Array<{ itemId?: string; title?: string }> }
          for (const item of [...(payload.items ?? []), ...(payload.results ?? [])]) {
            if (item.itemId && item.title) titles.set(item.itemId, item.title)
          }
          resultIds.set(block.tool_use_id, [...(payload.items ?? []), ...(payload.results ?? [])]
            .map((item) => item.itemId)
            .filter((itemId): itemId is string => typeof itemId === 'string'))
          completed.add(block.tool_use_id)
        } catch {
          // 非 JSON 成功结果不能可靠关联具体资料，故不展示读取标签。
        }
      }
    }
  }

  const ids = new Set<string>()
  for (const [toolUseId, itemIds] of calls) {
    if (completed.has(toolUseId)) for (const itemId of [...itemIds, ...(resultIds.get(toolUseId) ?? [])]) ids.add(itemId)
  }
  return [...ids].map((itemId) => ({ itemId, title: titles.get(itemId) ?? itemId }))
}
