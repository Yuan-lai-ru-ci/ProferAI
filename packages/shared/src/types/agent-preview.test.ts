import { describe, expect, test } from 'bun:test'
import {
  AGENT_PREVIEW_DEFAULT_MODE_BY_KIND,
  AGENT_PREVIEW_LIMITS,
  type InspectPreviewError,
  type InspectPreviewInput,
  type InspectPreviewResult,
} from './agent-preview'

describe('Agent preview contract', () => {
  test('defines the input fields used by both runtimes', () => {
    const input: InspectPreviewInput = {
      filePath: 'deck.pptx',
      mode: 'both',
      scope: 'page',
      page: 3,
      previousRevision: 'sha256:old',
    }
    expect(input.scope).toBe('page')
  })

  test('defines a runtime-neutral result and structured error', () => {
    const result: InspectPreviewResult = {
      file: { name: 'slide.png', kind: 'image', size: 12, modifiedAt: '2026-09-03T00:00:00.000Z', revision: 'sha256:x' },
      visual: { scope: 'page', page: 1, images: [{ data: 'base64', mediaType: 'image/png', page: 1 }] },
    }
    const error: InspectPreviewError = { error: { code: 'renderer_failed', message: 'render failed', retryable: true } }
    expect(result.visual?.images[0]?.mediaType).toBe('image/png')
    expect(error.error.retryable).toBe(true)
  })

  test('keeps conservative defaults and explicit budgets', () => {
    expect(AGENT_PREVIEW_DEFAULT_MODE_BY_KIND.text).toBe('content')
    expect(AGENT_PREVIEW_DEFAULT_MODE_BY_KIND.presentation).toBe('both')
    expect(AGENT_PREVIEW_LIMITS.maxPages).toBeGreaterThan(0)
    expect(AGENT_PREVIEW_LIMITS.maxPayloadBytes).toBeGreaterThan(AGENT_PREVIEW_LIMITS.maxFileBytes / 2)
  })
})
