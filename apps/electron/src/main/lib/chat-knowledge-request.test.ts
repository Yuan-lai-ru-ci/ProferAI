import { describe, expect, test } from 'bun:test'
import { prepareChatKnowledgeRequest } from './chat-knowledge-request'
import type { ChatMessage, KnowledgeReference, KnowledgeSearchResult } from '@profer/shared'

const reference: KnowledgeReference = { itemId: '11111111-1111-4111-8111-111111111111', title: '附件文章', kind: 'markdown', origin: 'local', importedAt: 1 }
const item = { id: reference.itemId, title: reference.title, kind: reference.kind, origin: reference.origin, fileSize: 1, importedAt: 1, updatedAt: 1, tags: [], syncState: 'local-only' as const }

function searchResult(content: string): KnowledgeSearchResult {
  return { item, content, startIndex: 0, endIndex: content.length, score: 0 }
}

describe('Chat provider 资料请求', () => {
  test('Given 本轮问题和资料引用 When 准备 provider 内容 Then 原问题与受控上下文在同一个请求中', async () => {
    const prepared = await prepareChatKnowledgeRequest(
      { userMessage: '总结这篇文章', history: [], currentReferences: [reference] },
      { enrichMessage: async (message) => message, search: async (_query, ids) => { expect(ids).toEqual([reference.itemId]); return [searchResult('文章开头的有限正文')] } },
    )
    expect(prepared.providerUserMessage).toContain('总结这篇文章')
    expect(prepared.providerUserMessage).toContain('<knowledge_context>')
    expect(prepared.providerUserMessage).toContain('文章开头的有限正文')
    expect(prepared.effectiveReferences).toEqual([reference])
  })

  test('Given 当前问题无引用但有效历史有引用 When 准备 provider 内容 Then 只使用未被上下文裁剪的历史 allowlist', async () => {
    const history: ChatMessage[] = [{ id: 'message-1', role: 'user', content: '先前问题', createdAt: 1, knowledgeReferences: [reference] }]
    const prepared = await prepareChatKnowledgeRequest(
      { userMessage: '继续说明', history },
      { enrichMessage: async (message) => message, search: async (_query, ids) => { expect(ids).toEqual([reference.itemId]); return [searchResult('历史资料的受控片段')] } },
    )
    expect(prepared.providerUserMessage).toContain('历史资料的受控片段')
  })

  test('Given 资料搜索失败 When 准备请求 Then 由调用方决定降级且原问题保持完整', async () => {
    await expect(prepareChatKnowledgeRequest(
      { userMessage: '仍要发送的问题', history: [], currentReferences: [reference] },
      { enrichMessage: async (message) => message, search: async () => { throw new Error('temporary failure') } },
    )).rejects.toThrow('temporary failure')
  })
})
