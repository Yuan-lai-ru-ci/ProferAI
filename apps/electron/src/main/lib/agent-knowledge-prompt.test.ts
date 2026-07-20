import { describe, expect, test } from 'bun:test'
import { buildAgentKnowledgePrompt } from './agent-knowledge-prompt'

describe('Agent 资料读取提示词', () => {
  test('Given 当前会话未授权资料 When 构建提示词 Then 不注入资料指令', () => {
    expect(buildAgentKnowledgePrompt([])).toBe('')
  })

  test('Given 当前会话已授权资料 When 构建提示词 Then 仅声明 allowlist 并要求先走受控 MCP', () => {
    const prompt = buildAgentKnowledgePrompt([{ itemId: 'allowed-id', title: '活动方案', kind: 'word', origin: 'local', importedAt: 1 }])
    expect(prompt).toContain('活动方案')
    expect(prompt).toContain('allowed-id')
    expect(prompt).toContain('mcp__knowledge-base__read_imported_knowledge')
    expect(prompt).toContain('不要尝试通过文件路径、目录或其他工具访问资料')
    expect(prompt).toContain('直至 hasMore 为 false 后再回答')
    expect(prompt).toContain('不能因此声称资料只索引了部分')
  })
})
