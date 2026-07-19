import { describe, expect, test } from 'bun:test'
import { buildChatKnowledgeContext } from './chat-knowledge-context'
import type { KnowledgeReference, KnowledgeSearchResult } from '@profer/shared'

const references: KnowledgeReference[] = [
  { itemId: '11111111-1111-4111-8111-111111111111', title: '安全 <设计>', kind: 'markdown', origin: 'local', importedAt: 1 },
  { itemId: '22222222-2222-4222-8222-222222222222', title: '研究论文', kind: 'pdf', origin: 'arxiv', importedAt: 1 },
]

function result(itemId: string, content: string): KnowledgeSearchResult {
  const reference = references.find((item) => item.itemId === itemId)!
  return {
    item: { id: reference.itemId, title: reference.title, kind: reference.kind, origin: reference.origin, fileSize: 1, importedAt: 1, updatedAt: 1, tags: [], syncState: 'local-only' },
    content, startIndex: 0, endIndex: content.length, score: 1,
  }
}

describe('Chat 资料引用上下文', () => {
  test('Given 当前会话的两份引用 When 查询命中 Then 只注入 allowlist 的有限带来源片段', async () => {
    let receivedIds: string[] = []
    const context = await buildChatKnowledgeContext('安全设计', references, async (_query, ids) => {
      receivedIds = ids
      return [result(references[0]!.itemId, '相关的有限资料片段')]
    })
    expect(receivedIds).toEqual(references.map((reference) => reference.itemId))
    expect(context).toContain('<knowledge_context>')
    expect(context).toContain(`item_id="${references[0]!.itemId}"`)
    expect(context).toContain('title="安全 &lt;设计&gt;"')
    expect(context).not.toContain(references[1]!.itemId)
  })

  test('Given 空问题或没有引用 When 构建 Then 不检索且不伪造上下文', async () => {
    const search = async (): Promise<KnowledgeSearchResult[]> => { throw new Error('不应调用') }
    expect(await buildChatKnowledgeContext('', references, search)).toBe('')
    expect(await buildChatKnowledgeContext('问题', [], search)).toBe('')
  })

  test('Given 已删除资料没有匹配片段 When 查询 Then 不阻塞且返回空上下文', async () => {
    expect(await buildChatKnowledgeContext('问题', references, async () => [])).toBe('')
  })

  test('Given 资料附件正文与问题没有词面重合 When 检索器提供首段 Then 仍把附件正文交给模型', async () => {
    const context = await buildChatKnowledgeContext('总结这篇文章', references, async () => [result(references[0]!.itemId, '文章标题和摘要的首段内容')])
    expect(context).toContain('文章标题和摘要的首段内容')
  })
})
