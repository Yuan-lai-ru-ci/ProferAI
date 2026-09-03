import { describe, expect, test } from 'bun:test'
import {
  AGENT_INSPECT_PREVIEW_TOOL_NAME,
  formatAgentPreviewToolResult,
  injectAgentPreviewMcpServer,
} from './agent-preview-tools'

describe('Agent preview Claude adapter', () => {
  test('registers the shared inspect_preview MCP tool with its content and visual schema', async () => {
    const captured: Array<{ name: string; description: string; schema: unknown }> = []
    const servers: Record<string, Record<string, unknown>> = {}
    const sdk = {
      tool(name: string, description: string, schema: unknown) {
        captured.push({ name, description, schema })
        return { name }
      },
      createSdkMcpServer(input: { name: string; version: string; tools: unknown[] }) { return input },
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')

    await injectAgentPreviewMcpServer(sdk, servers, { agentCwd: '/safe/session', allowedRoots: ['/safe/attached'] })

    expect(Object.keys(servers)).toEqual(['agent-preview'])
    expect(captured[0]).toMatchObject({ name: AGENT_INSPECT_PREVIEW_TOOL_NAME })
    expect(JSON.stringify(captured[0]?.schema)).toContain('previousRevision')
    expect(JSON.stringify(captured[0]?.schema)).toContain('overview')
  })

  test('returns text metadata plus runtime image blocks without putting image bytes in text', () => {
    const formatted = formatAgentPreviewToolResult({
      file: { name: 'deck.pptx', kind: 'presentation', size: 42, modifiedAt: '2026-09-03T00:00:00.000Z', revision: 'sha256:abc' },
      visual: { scope: 'page', page: 2, images: [{ data: 'PNG_BYTES', mediaType: 'image/png', filename: 'deck.pptx', page: 2 }] },
    })
    expect(formatted.content).toHaveLength(2)
    expect(formatted.content[0]).toMatchObject({ type: 'text' })
    expect((formatted.content[0] as { text: string }).text).not.toContain('PNG_BYTES')
    expect(formatted.content[1]).toEqual({ type: 'image', data: 'PNG_BYTES', mimeType: 'image/png' })
  })

  test('keeps structured errors as text only', () => {
    const formatted = formatAgentPreviewToolResult({ error: { code: 'unauthorized_path', message: 'denied', retryable: false } })
    expect(formatted.content).toHaveLength(1)
    expect(formatted.details).toMatchObject({ error: { code: 'unauthorized_path' } })
  })
})
