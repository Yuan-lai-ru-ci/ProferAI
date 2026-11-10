import { describe, expect, test } from 'bun:test'
import { finalizePiToolDefinitions } from './pi-agent-adapter'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

function tool(name: string, run = () => {}): ToolDefinition {
  return { name, label: name, description: name, parameters: {} as never,
    execute: async () => { run(); return { content: [], details: {} } },
  } as ToolDefinition
}

describe('Pi 最终工具硬门禁', () => {
  test('原生与 custom 合并后按 canonical 身份过滤，不把 allowedTools 当注册白名单', () => {
    const tools = finalizePiToolDefinitions([tool('bash'), tool('read'), tool('find'), tool('ls'), tool('mcp__demo__blocked')], ['Bash', 'Read', 'Glob', 'blocked'])
    expect(tools.map(t => t.name)).toEqual(['ls'])
  })
  test('已捕获工具引用在执行前仍拒绝禁用项（不依赖审批或 bypass）', async () => {
    let calls = 0
    const definition = tool('ls', () => { calls++ })
    const tools = finalizePiToolDefinitions([definition], ['Bash'])
    definition.name = 'bash'
    await expect(tools[0]!.execute('call', {}, new AbortController().signal, undefined, {} as never)).rejects.toThrow('denied by policy')
    expect(calls).toBe(0)
  })
})
