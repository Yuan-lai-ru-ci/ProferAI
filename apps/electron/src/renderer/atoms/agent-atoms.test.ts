import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@profer/shared'
import type { AgentStreamState } from './agent-atoms'
import { applyAgentEvent } from './agent-atoms'

function state(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    content: '',
    toolActivities: [],
    retrying: {
      currentAttempt: 1,
      maxAttempts: 8,
      history: [],
      failed: false,
    },
    ...overrides,
  }
}

describe('applyAgentEvent retry recovery', () => {
  test('完整文本到达时清除非失败 retry 状态', () => {
    const event: AgentEvent = { type: 'text_complete', text: '完成', isIntermediate: false }
    expect(applyAgentEvent(state(), event).retrying).toBeUndefined()
  })

  test('retry_failed 的失败历史不会被完整文本清除', () => {
    const failed = {
      currentAttempt: 8,
      maxAttempts: 8,
      history: [],
      failed: true,
    }
    const event: AgentEvent = { type: 'text_complete', text: '错误后的文本', isIntermediate: false }
    expect(applyAgentEvent(state({ retrying: failed }), event).retrying).toBe(failed)
  })

  test('文本、工具和正常 complete 都只清除非失败 retry', () => {
    const failed = {
      currentAttempt: 8,
      maxAttempts: 8,
      history: [],
      failed: true,
    }
    const events: AgentEvent[] = [
      { type: 'text_delta', text: '继续' },
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tool-1', input: {} },
      { type: 'complete' },
    ]
    for (const event of events) {
      expect(applyAgentEvent(state({ retrying: failed }), event).retrying).toBe(failed)
    }
    expect(applyAgentEvent(state(), { type: 'complete' }).retrying).toBeUndefined()
  })
})
