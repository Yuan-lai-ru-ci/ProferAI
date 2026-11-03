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
    expect(isKnownCompactPiTool('mcp__task-graph__profer_task_create', { allowBuiltinMcpNames: true })).toBe(true)
    expect(isKnownCompactPiTool('mcp__task-graph__profer_task_create')).toBe(false)
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

  // 委派工具的 presetReference 描述不能在压缩后丢失：模型只看到「有这个可选字段」
  // 就会习惯性把引用补成四字段对象，触发全局 scope 携带 workspaceSlug 的严格校验。
  test('委派工具压缩后仍保留 presetReference / workspaceSlug 的说明', () => {
    const presetReferenceSchema = {
      type: 'object',
      description: 'schema 层的长说明会被压缩掉',
      properties: {
        presetId: { type: 'string', description: 'id 说明' },
        workspaceSlug: { type: 'string', description: 'slug 说明' },
      },
    }
    const single = tool('mcp__collaboration__delegate_agent')
    single.parameters = {
      type: 'object',
      properties: { presetReference: presetReferenceSchema },
    } as never
    const batch = tool('mcp__collaboration__delegate_agents')
    batch.parameters = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { presetReference: presetReferenceSchema } },
        },
      },
    } as never

    const compactedSingle = compactPiToolDefinition(single, { allowBuiltinMcpNames: true })
    const compactedBatch = compactPiToolDefinition(batch, { allowBuiltinMcpNames: true })

    expect(compactedSingle.description).toContain('不要自行补字段')
    expect(compactedBatch.description).toContain('不要自行补字段')

    type ReferenceProperties = { properties: Record<string, { properties: Record<string, { description?: string }> }> }
    const singleProps = (compactedSingle.parameters as unknown as ReferenceProperties).properties
    expect(singleProps.presetReference!.properties.workspaceSlug!.description).toContain('presetScope=workspace')

    const batchProps = (compactedBatch.parameters as unknown as { properties: { items: { items: ReferenceProperties } } }).properties
    expect(batchProps.items.items.properties.presetReference!.properties.workspaceSlug!.description).toContain('presetScope=workspace')
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
