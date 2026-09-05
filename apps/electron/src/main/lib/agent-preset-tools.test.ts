import { describe, expect, test } from 'bun:test'
import { injectAgentPresetMcpServer } from './agent-preset-tools'

describe('Agent preset MCP gate', () => {
  test('Agent runtime only registers read-only preset_list', async () => {
    const servers: Record<string, Record<string, unknown>> = {}
    const sdk = {
      tool(name: string) { return { name } },
      createSdkMcpServer(input: { name: string; version: string; tools: Array<{ name: string }> }) { return input },
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')

    await injectAgentPresetMcpServer(sdk, servers, { sessionId: 'missing-session' })

    const server = servers['agent-presets'] as unknown as { tools: Array<{ name: string }> }
    expect(server.tools.map((tool) => tool.name)).toEqual(['preset_list'])
  })
})
