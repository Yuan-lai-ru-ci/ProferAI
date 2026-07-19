import { describe, expect, test } from 'bun:test'
import { extractReadKnowledgeItems } from './knowledge-read-indicator'

describe('Agent 已读取资料标识', () => {
  test('Given 成功的受控资料读取工具调用 When 提取 Then 返回工具结果中的资料', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__knowledge-base__read_imported_knowledge', input: { itemIds: ['item-1'] } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify({ items: [{ itemId: 'item-1', title: '活动方案', content: '正文' }] }) }] } },
    ] as never[]
    expect(extractReadKnowledgeItems(messages)).toEqual([{ itemId: 'item-1', title: '活动方案' }])
  })

  test('Given 未授权或不可用结果 When 提取 Then 不展示已读取资料', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__knowledge-base__read_imported_knowledge', input: { itemIds: ['item-1'] } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify({ error: 'KNOWLEDGE_ITEM_NOT_IMPORTED' }) }] } },
    ] as never[]
    expect(extractReadKnowledgeItems(messages)).toEqual([])
  })
})
