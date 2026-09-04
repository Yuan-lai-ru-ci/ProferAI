import { describe, expect, test } from 'bun:test'

// The project-wide Bun suite has other Electron mocks. These pure contract tests avoid
// constructing BrowserWindow, while still protecting the untrusted-URL boundary.

const {
  AgentPreviewRendererError,
  isSafeAgentPreviewSourceUrl,
} = await import('./agent-preview-renderer')

describe('hidden Agent preview renderer', () => {
  test('accepts only opaque profer-file resource URLs', () => {
    expect(isSafeAgentPreviewSourceUrl('profer-file://8f32ce7a-06fb-4b08-9b88-90f9f4f3c07c/index.html')).toBe(true)
    expect(isSafeAgentPreviewSourceUrl('file:///Users/private/deck.pptx')).toBe(false)
    expect(isSafeAgentPreviewSourceUrl('https://example.test/deck.html')).toBe(false)
  })

  test('exports a structured renderer error for lifecycle failures', () => {
    const error = new AgentPreviewRendererError('page_out_of_range', 'out of range', false)
    expect(error).toMatchObject({ code: 'page_out_of_range', retryable: false })
  })
})
