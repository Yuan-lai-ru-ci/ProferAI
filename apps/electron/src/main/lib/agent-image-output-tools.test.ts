import { describe, expect, test } from 'bun:test'
import { formatAgentImageOutputToolResult, injectAgentImageOutputMcpServer } from './agent-image-output-tools'

describe('Agent local image output tool', () => {
  test('Given a Claude SDK stub When injecting Then it registers send_local_image with an image-output MCP server', async () => {
    const captured: Array<{ name: string; description: string; schema: unknown }> = []
    const servers: Record<string, Record<string, unknown>> = {}
    const sdk = {
      tool(name: string, description: string, schema: unknown) {
        captured.push({ name, description, schema })
        return { name }
      },
      createSdkMcpServer(input: { name: string; version: string; tools: unknown[] }) {
        return input
      },
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')

    await injectAgentImageOutputMcpServer(sdk, servers, {
      agentCwd: 'C:/safe/session',
      allowedRoots: ['C:/safe/attached'],
    })

    expect(Object.keys(servers)).toEqual(['agent-image-output'])
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ name: 'send_local_image' })
    expect(captured[0]!.description).not.toContain('IMAGE_ATTACHMENT')
  })

  test('Given a safe image result When formatting tool output Then it returns a structured image without exposing an internal marker', () => {
    const formatted = formatAgentImageOutputToolResult({
      image: { localPath: 'C:/safe/image.png', absolutePath: 'C:/safe/image.png', filename: 'image.png', mediaType: 'image/png' },
    })

    expect(formatted.content[0]!.text).not.toContain('IMAGE_ATTACHMENT')
    expect(formatted.details).toMatchObject({ image: { filename: 'image.png', mediaType: 'image/png' } })
  })
})
