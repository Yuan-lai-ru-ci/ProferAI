import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@profer/shared'
import {
  createHeadlessCompletionForwarder,
  forwardHeadlessAgentCompletion,
  getAgentStopCompletionOptions,
} from './agent-headless-runner-registry'

describe('getAgentStopCompletionOptions', () => {
  test('Given a user stop When building terminal fields Then preserves user interruption semantics', () => {
    expect(getAgentStopCompletionOptions('user')).toEqual({ stoppedByUser: true })
  })

  test('Given a parent delegation cancellation When building terminal fields Then it carries stop facts without forging provider subtype', () => {
    expect(getAgentStopCompletionOptions('delegation_cancel')).toEqual({
      stoppedByUser: false,
      stopReason: 'delegation_cancel',
    })
  })

  test('Given a delegation record pre-marked cancelled When its child onComplete skips record cleanup Then service still forwards one complete payload', () => {
    const record: { status: 'running' | 'cancelled' } = { status: 'cancelled' }
    const callbackPayloads: unknown[][] = []
    const rendererPayloads: unknown[][] = []
    const messages = [{ role: 'assistant', content: 'child result' }] as AgentMessage[]
    const opts = {
      stoppedByUser: false,
      startedAt: 123,
      resultSubtype: 'delegation_cancelled',
      endReason: 'unknown' as const,
      endReasonLabel: '因父会话停止而取消',
    }

    forwardHeadlessAgentCompletion({
      callbacks: {
        onError: () => {},
        onComplete: (completedMessages, completedOpts) => {
          // 对应 collaboration 的 onComplete：预标 cancelled 时只跳过 delegation 收尾。
          if (record.status === 'running') callbackPayloads.push([completedMessages, completedOpts])
        },
        onTitleUpdated: () => {},
      },
      messages,
      opts,
      forwardToRenderer: (completedMessages, completedOpts) => {
        rendererPayloads.push([completedMessages, completedOpts])
      },
    })

    expect(callbackPayloads).toHaveLength(0)
    expect(rendererPayloads).toEqual([[messages, opts]])
  })
})

describe('createHeadlessCompletionForwarder（终态一次性转发）', () => {
  const harness = () => {
    const callbackPayloads: unknown[] = []
    const rendererPayloads: unknown[] = []
    const forward = createHeadlessCompletionForwarder()
    const callbacks = {
      onError: () => {},
      onComplete: (messages?: AgentMessage[], opts?: { endReason?: string }) => {
        callbackPayloads.push([messages, opts])
      },
      onTitleUpdated: () => {},
    }
    const forwardToRenderer = (messages?: AgentMessage[], opts?: { endReason?: string }) => {
      rendererPayloads.push([messages, opts])
    }
    return { callbackPayloads, rendererPayloads, forward, callbacks, forwardToRenderer }
  }

  test('Given a real terminal completion When forwarded twice Then the renderer sees it once', () => {
    const h = harness()
    const input = { callbacks: h.callbacks, opts: { endReason: 'completed' as const }, forwardToRenderer: h.forwardToRenderer }
    expect(h.forward(input)).toBe(true)
    expect(h.forward(input)).toBe(false)
    expect(h.callbackPayloads).toHaveLength(1)
    expect(h.rendererPayloads).toHaveLength(1)
  })

  test('Given background-task light completes When repeated Then they are not deduplicated', () => {
    const h = harness()
    const input = {
      callbacks: h.callbacks,
      opts: { backgroundTasksPending: true },
      forwardToRenderer: h.forwardToRenderer,
    }
    expect(h.forward(input)).toBe(true)
    expect(h.forward(input)).toBe(true)
    expect(h.rendererPayloads).toHaveLength(2)
  })

  test('Given light completes before the real terminal When the terminal arrives Then it is still delivered once', () => {
    const h = harness()
    expect(h.forward({ callbacks: h.callbacks, opts: { backgroundTasksPending: true }, forwardToRenderer: h.forwardToRenderer })).toBe(true)
    expect(h.forward({ callbacks: h.callbacks, opts: { endReason: 'completed' as const }, forwardToRenderer: h.forwardToRenderer })).toBe(true)
    expect(h.forward({ callbacks: h.callbacks, opts: { endReason: 'error' as const }, forwardToRenderer: h.forwardToRenderer })).toBe(false)
    expect(h.rendererPayloads).toHaveLength(2)
  })
})
