import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { compactPiToolDefinition, compactPiToolDefinitions, isKnownCompactPiTool } from './pi-tool-definition-compaction'

function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: 'A very long tool description that should be replaced for the model.',
    promptSnippet: 'A very long prompt snippet that should also be replaced.',
    parameters: {
      type: 'object',
      description: 'Root schema description',
      required: ['value'],
      properties: {
        value: { type: 'string', minLength: 1, maxLength: 10, description: 'Value description' },
        mode: { type: 'string', enum: ['a', 'b'], description: 'Mode description' },
        nested: {
          type: 'object',
          properties: { child: { type: 'number', minimum: 0, description: 'Child description' } },
          description: 'Nested description',
        },
      },
    } as never,
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }),
  }
}

describe('Pi 工具定义压缩', () => {
  test('已知 Profer 工具压缩模型说明，但保留结构约束与执行函数', () => {
    const original = tool('mcp__planning__update_todo')
    const compacted = compactPiToolDefinition(original, { allowBuiltinMcpNames: true })
    expect(compacted.description).toContain('expectedUpdatedAt')
    expect(compacted.description.length).toBeLessThan(original.description.length)
    expect(compacted.promptSnippet).toBe(compacted.description)
    expect(compacted.parameters).toEqual({
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string', minLength: 1, maxLength: 10 },
        mode: { type: 'string', enum: ['a', 'b'] },
        nested: { type: 'object', properties: { child: { type: 'number', minimum: 0 } } },
      },
    })
    expect(compacted.execute).toBe(original.execute)
  })

  test('浏览器工具和任务图工具均有短说明；未知 MCP/插件定义原样保留', () => {
    expect(isKnownCompactPiTool('BrowserObserve')).toBe(true)
    expect(isKnownCompactPiTool('mcp__task-graph__proma_task_create', { allowBuiltinMcpNames: true })).toBe(true)
    expect(isKnownCompactPiTool('mcp__task-graph__proma_task_create')).toBe(false)
    expect(isKnownCompactPiTool('mcp__custom__third_party')).toBe(false)
    const unknown = tool('mcp__custom__third_party')
    expect(compactPiToolDefinition(unknown)).toBe(unknown)
    const samePrefix = tool('mcp__automation__third_party_export')
    expect(compactPiToolDefinition(samePrefix)).toBe(samePrefix)
  })

  test('只删除 schema 节点说明，不改 const/default 等数据对象里的 description', () => {
    const original = tool('read')
    original.parameters = {
      type: 'object',
      properties: {
        value: {
          type: 'object',
          const: { description: 'literal', kind: 'x' },
          description: 'schema description',
        },
      },
    } as never
    const compacted = compactPiToolDefinition(original)
    expect(compacted.parameters).toEqual({
      type: 'object',
      properties: { value: { type: 'object', const: { description: 'literal', kind: 'x' } } },
    })
  })

  test('批量压缩不改变工具数量、名称或参数的非描述部分', () => {
    const original = [tool('read'), tool('BrowserNavigate'), tool('mcp__automation__create_automation'), tool('mcp__custom__third_party')]
    const compacted = compactPiToolDefinitions(original)
    expect(compacted).toHaveLength(original.length)
    expect(compacted.map(item => item.name)).toEqual(original.map(item => item.name))
    expect(compacted[3]).toBe(original[3])
    expect(JSON.stringify(compacted[0]?.parameters)).not.toContain('description')
    expect(JSON.stringify(compacted[1]?.parameters)).not.toContain('description')
  })
})
