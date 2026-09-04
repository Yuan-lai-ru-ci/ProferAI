import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { shouldShowAgentRunningIndicator } from './agent-running-indicator'

function assistantMessage(error?: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: error ?? '正常输出' }] },
    parent_tool_use_id: null,
    ...(error ? { error: { message: error, errorType: 'provider_error' } } : {}),
  } as SDKMessage
}

describe('shouldShowAgentRunningIndicator', () => {
  test('Given a running stream without errors Then shows the running indicator', () => {
    expect(shouldShowAgentRunningIndicator({
      streaming: true,
      liveMessages: [assistantMessage()],
    })).toBe(true)
  })

  test('Given STREAM_ERROR has arrived Then hides the running indicator', () => {
    expect(shouldShowAgentRunningIndicator({
      streaming: true,
      streamError: '上游服务繁忙',
      liveMessages: [assistantMessage()],
    })).toBe(false)
  })

  test('Given a terminal assistant error is already visible Then hides the running indicator', () => {
    expect(shouldShowAgentRunningIndicator({
      streaming: true,
      liveMessages: [assistantMessage('上游服务繁忙')],
    })).toBe(false)
  })
})
