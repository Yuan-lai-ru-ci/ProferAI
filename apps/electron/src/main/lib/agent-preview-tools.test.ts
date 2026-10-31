import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_INSPECT_PREVIEW_TOOL_NAME,
  executeAgentPreviewTool,
  executeInspectFilePreviewTool,
  executeOpenFilePreviewTool,
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

    await injectAgentPreviewMcpServer(sdk, servers, {
      sessionId: 'session-1',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/attached'],
      onRequest: async (event) => ({
        requestId: event.requestId,
        sessionId: event.sessionId,
        filePath: event.filePath,
        revision: event.revision,
        status: 'ready',
        slideCount: 1,
        currentSlide: 1,
      }),
      onInspectRequest: async (request) => ({ ...request, slideCount: 1, currentSlide: 1, images: [] }),
    })

    expect(Object.keys(servers)).toEqual(['agent-preview'])
    expect(captured.map((tool) => tool.name)).toContain('open_file_preview')
    expect(captured.map((tool) => tool.name)).toContain('inspect_file_preview')
    expect(captured.map((tool) => tool.name)).toContain(AGENT_INSPECT_PREVIEW_TOOL_NAME)
    const inspectTool = captured.find((tool) => tool.name === AGENT_INSPECT_PREVIEW_TOOL_NAME)
    expect(JSON.stringify(inspectTool?.schema)).toContain('previousRevision')
    expect(JSON.stringify(inspectTool?.schema)).toContain('overview')
  })

  test('routes PPTX away from the generic screenshot inspector', async () => {
    const result = await executeAgentPreviewTool({ filePath: '/safe/session/deck.pptx', mode: 'visual' }, { agentCwd: '/safe/session', allowedRoots: [] })
    expect(result.details).toMatchObject({ error: { code: 'unsupported_file_type', retryable: false } })
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  test('opens PPTX through the official Profer preview event without returning screenshot bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-ppt-preview-'))
    try {
      const filePath = join(dir, 'deck.pptx')
      writeFileSync(filePath, 'pptx-fixture')
      const events: Array<{ type: 'preview_requested'; requestId: string; sessionId: string; filePath: string; revision: string; basePaths?: string[]; readOnly?: boolean }> = []
      const result = await executeOpenFilePreviewTool(
        { filePath },
        {
          sessionId: 'session-1',
          agentCwd: dir,
          allowedRoots: [],
          onRequest: async (event) => {
            events.push(event)
            return { ...event, status: 'ready', slideCount: 2, currentSlide: 1 }
          },
        },
      )
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toMatchObject({ type: 'text' })
      expect((result.content[0] as { type: 'text'; text: string }).text).not.toContain('base64')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'preview_requested',
        sessionId: 'session-1',
        filePath: realpathSync(filePath),
        revision: expect.stringMatching(/^sha256:/),
        basePaths: [realpathSync(dir)],
        readOnly: true,
      })
      expect(events[0]?.requestId).toBeString()
      expect('file' in result.details).toBe(true)
      if ('file' in result.details) {
        expect(result.details.file.revision).toMatch(/^sha256:/)
        expect(result.details.file.size).toBeGreaterThan(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('inspects the matching revision from the same official visible PPTX viewer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-ppt-inspect-'))
    try {
      const filePath = join(dir, 'deck.pptx')
      writeFileSync(filePath, 'pptx-fixture')
      const result = await executeInspectFilePreviewTool(
        { filePath, scope: 'page', page: 2 },
        {
          sessionId: 'session-1',
          agentCwd: dir,
          allowedRoots: [],
          onInspectRequest: async (request) => ({
            ...request,
            slideCount: 3,
            currentSlide: 1,
            images: [{ page: 2, data: 'PNG_BYTES', mediaType: 'image/png' }],
          }),
        },
      )
      expect(result.content).toHaveLength(3)
      expect(result.content[1]).toEqual({ type: 'image', data: 'PNG_BYTES', mimeType: 'image/png' })
      expect((result.content[2] as { text: string }).text).toContain('不要用 send_local_image')
      expect(result.details).toMatchObject({ visual: { scope: 'page', page: 2, images: [{ page: 2 }] } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects non-PPTX files instead of routing them through the official PPT preview', async () => {
    const events: unknown[] = []
    await expect(executeOpenFilePreviewTool(
      { filePath: '/safe/session/readme.md' },
      { sessionId: 'session-1', agentCwd: '/safe/session', allowedRoots: [], onRequest: async (event) => { events.push(event); return { ...event, status: 'ready' } } },
    )).rejects.toThrow('仅用于 PPTX')
    expect(events).toHaveLength(0)
  })

  test('returns text metadata plus runtime image blocks without putting image bytes in text', () => {
    const formatted = formatAgentPreviewToolResult({
      file: { name: 'deck.pptx', kind: 'presentation', size: 42, modifiedAt: '2026-09-03T00:00:00.000Z', revision: 'sha256:abc' },
      visual: { scope: 'page', page: 2, images: [{ data: 'PNG_BYTES', mediaType: 'image/png', filename: 'deck.pptx', page: 2 }] },
    })
    expect(formatted.content).toHaveLength(3)
    expect(formatted.content[0]).toMatchObject({ type: 'text' })
    expect((formatted.content[0] as { text: string }).text).not.toContain('PNG_BYTES')
    expect(formatted.content[1]).toEqual({ type: 'image', data: 'PNG_BYTES', mimeType: 'image/png' })
    expect((formatted.content[2] as { text: string }).text).toContain('仅供你观察核验')
  })

  test('caps preview images per model result by base64 byte budget', () => {
    const images = Array.from({ length: 20 }, (_, index) => ({
      data: 'A'.repeat(500_000),
      mediaType: 'image/jpeg' as const,
      filename: 'deck.pptx',
      page: index + 1,
    }))
    const formatted = formatAgentPreviewToolResult({
      file: { name: 'deck.pptx', kind: 'presentation', size: 42, modifiedAt: '2026-09-03T00:00:00.000Z', revision: 'sha256:abc' },
      visual: { scope: 'all', images },
    })

    const imageBlocks = formatted.content.filter((block) => block.type === 'image')
    expect(imageBlocks).toHaveLength(8)
    const summary = JSON.parse((formatted.content[0] as { type: string; text: string }).text) as {
      visual: { images: unknown[]; totalImages?: number }
    }
    expect(summary.visual.images).toHaveLength(8)
    expect(summary.visual.totalImages).toBe(20)
    const last = formatted.content[formatted.content.length - 1] as { type: string; text: string }
    expect(last.type).toBe('text')
    expect(last.text).toContain('本次仅返回前 8/20 张图片')
  })

  test('keeps structured errors as text only', () => {
    const formatted = formatAgentPreviewToolResult({ error: { code: 'unauthorized_path', message: 'denied', retryable: false } })
    expect(formatted.content).toHaveLength(1)
    expect(formatted.details).toMatchObject({ error: { code: 'unauthorized_path' } })
  })
})
