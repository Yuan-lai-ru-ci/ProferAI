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

  test('retry_failed 只记录失败，不提前结束运行态', () => {
    const event: AgentEvent = {
      type: 'retry_failed',
      finalAttempt: {
        attempt: 8,
        timestamp: Date.now(),
        reason: '服务暂时不可用',
        errorMessage: '服务暂时不可用',
        delaySeconds: 0,
      },
    }
    const next = applyAgentEvent(state(), event)
    expect(next.running).toBe(true)
    expect(next.retrying?.failed).toBe(true)
  })

  test('失败历史不会被完整文本清除', () => {
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

describe('applyAgentEvent 压缩状态', () => {
  test('自动压缩只标记压缩中，不把整轮当成手动压缩 run', () => {
    const compacting = applyAgentEvent(state(), { type: 'compacting' })
    expect(compacting.isCompacting).toBe(true)
    expect(compacting.compactInFlight).toBeUndefined()
  })

  test('自动压缩结束后本轮继续执行：压缩锁释放且不残留抑制标记', () => {
    const completed = applyAgentEvent(applyAgentEvent(state(), { type: 'compacting' }), { type: 'compact_complete' })
    expect(completed).toMatchObject({ running: true, isCompacting: false })
    expect(completed.compactInFlight).toBeUndefined()
  })

  test('手动压缩 run 的 compactInFlight 跨过 compact_boundary 保留到 run 结束', () => {
    const manual = state({ isCompacting: true, compactInFlight: true })
    const afterBoundary = applyAgentEvent(manual, { type: 'compact_complete' })
    expect(afterBoundary).toMatchObject({ isCompacting: false, compactInFlight: true })
  })

  test('压缩失败/取消同样释放压缩锁，不把会话留在不可输入的压缩态', () => {
    const failed = applyAgentEvent(state({ isCompacting: true }), { type: 'compact_failed' })
    expect(failed).toMatchObject({ running: true, isCompacting: false })
  })
})
