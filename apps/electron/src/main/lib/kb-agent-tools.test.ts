import { describe, expect, test } from 'bun:test'
import { pageKnowledgeText } from './kb-agent-tools'

describe('Agent 资料分页读取', () => {
  test('Given 超过默认窗口的正文 When 读取第一页 Then 返回范围和后续标识', () => {
    const page = pageKnowledgeText('a'.repeat(7_000))
    expect(page).toMatchObject({ startIndex: 0, endIndex: 6_000, totalChars: 7_000, hasMore: true })
    expect(page.content).toHaveLength(6_000)
  })

  test('Given 上一页终点 When 续读 Then 返回剩余正文并结束', () => {
    const page = pageKnowledgeText('a'.repeat(7_000), 6_000)
    expect(page).toMatchObject({ startIndex: 6_000, endIndex: 7_000, totalChars: 7_000, hasMore: false })
    expect(page.content).toHaveLength(1_000)
  })

  test('Given 超出边界的请求 When 分页 Then 限制为安全范围', () => {
    expect(pageKnowledgeText('abcdef', -1, 99_999)).toMatchObject({ startIndex: 0, endIndex: 6, hasMore: false })
    expect(pageKnowledgeText('abcdef', 99)).toMatchObject({ startIndex: 6, endIndex: 6, content: '', hasMore: false })
  })
})
