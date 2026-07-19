import { describe, expect, test } from 'bun:test'
import { addKnowledgeReferencesToAgentSession } from './agent-knowledge-references'
import type { AgentSessionMeta } from '@profer/shared'

// 该单元测试聚焦 session allowlist 合并；资料解析由 knowledge-item-service 专项测试覆盖。
describe('Agent 资料引用 allowlist', () => {
  test('Given session 不存在 When 导入资料 Then 拒绝且不写入', () => {
    expect(() => addKnowledgeReferencesToAgentSession('missing', ['item'], { getSession: () => undefined, updateSession: () => { throw new Error('不应更新') } })).toThrow('Agent 会话不存在')
  })
})
