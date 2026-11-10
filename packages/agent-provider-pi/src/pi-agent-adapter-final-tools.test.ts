import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realSdk from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

let captured: { customTools: ToolDefinition[]; noTools: unknown } | undefined
mock.module('@earendil-works/pi-coding-agent', () => ({
  ...realSdk,
  createAgentSession: async (options: { customTools: ToolDefinition[]; noTools: unknown }) => {
    captured = options
    // 在 SDK 接收边界停止，不启动模型或执行任何原生工具。
    throw new Error('fixture captured final registration')
  },
}))
const { PiAgentAdapter } = await import('./pi-agent-adapter')

for (const permissionMode of ['auto', 'bypassPermissions'] as const) {
  test(`真实 Pi adapter ${permissionMode}: SDK 最终集排除 native/custom/alias`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-final-tools-'))
    const adapter = new PiAgentAdapter()
    captured = undefined
    let executions = 0
    const tool = (name: string): ToolDefinition => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => { executions++; return { content: [], details: {} } } })
    try {
      try {
        for await (const _message of adapter.query({
        sessionId: `policy-${permissionMode}`, prompt: 'fixture', provider: 'anthropic', apiKey: 'fake', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
        permissionMode, systemPrompt: 'fixture', cwd: root, piAgentDir: root, piSessionDir: root,
        disallowedTools: ['Bash', 'Read', 'Glob', 'blocked'],
        prepared: { tools: [tool('mcp__demo__blocked'), tool('visible')], disallowedTools: ['Write'] },
        })) { /* 不涉及网络 */ }
      } catch (error) {
        expect(String(error)).toContain('fixture captured final registration')
      }
      expect(captured).toBeDefined()
      expect(captured!.noTools).toBe('builtin')
      const names = captured!.customTools.map(tool => tool.name)
      for (const name of ['bash', 'read', 'find', 'write', 'mcp__demo__blocked']) expect(names).not.toContain(name)
      expect(names).toContain('visible')
      expect(names).toContain('ls')
      expect(executions).toBe(0)
    } finally {
      adapter.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
