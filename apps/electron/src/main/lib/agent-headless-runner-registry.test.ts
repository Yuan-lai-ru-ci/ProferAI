import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@profer/shared'
import { forwardHeadlessAgentCompletion, getAgentStopCompletionOptions } from './agent-headless-runner-registry'

describe('getAgentStopCompletionOptions', () => {
  test('Given a user stop When building terminal fields Then preserves user interruption semantics', () => {
    expect(getAgentStopCompletionOptions('user')).toEqual({ stoppedByUser: true })
  })

  test('Given a parent delegation cancellation When building terminal fields Then it is not attributed to the user', () => {
    expect(getAgentStopCompletionOptions('delegation_cancel')).toEqual({
      stoppedByUser: false,
      resultSubtype: 'delegation_cancelled',
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
