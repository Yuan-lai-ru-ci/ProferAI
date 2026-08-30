import { describe, expect, test } from 'bun:test'
import { createPiRetryTerminalGate, mapPiNativeRetryEvent } from './pi-retry-control'

describe('mapPiNativeRetryEvent (SDK 0.84.3 映射)', () => {
  const ts = 1_000_000

  test('auto_retry_start -> starting', () => {
    const out = mapPiNativeRetryEvent(
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'upstream failed' },
      ts,
    )
    expect(out).toEqual([{
      status: 'starting',
      attempt: 1,
      maxAttempts: 3,
      delaySeconds: 2,
      reason: 'upstream failed',
    }])
  })

  test('auto_retry_start 无 errorMessage 时用兜底文案', () => {
    const out = mapPiNativeRetryEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 500 }, ts)
    expect(out[0]).toMatchObject({ status: 'starting', reason: '未知错误' })
  })

  test('auto_retry_attempt_start -> attempt（记录退避时长）', () => {
    const out = mapPiNativeRetryEvent(
      { type: 'auto_retry_attempt_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'retrying now' },
      ts,
    )
    expect(out).toEqual([{
      status: 'attempt',
      attemptData: {
        attempt: 2,
        timestamp: ts,
        reason: 'retrying now',
        errorMessage: 'retrying now',
        delaySeconds: 4,
      },
    }])
  })

  test('auto_retry_attempt_start 无 errorMessage 时用兜底文案', () => {
    const out = mapPiNativeRetryEvent({ type: 'auto_retry_attempt_start', attempt: 1, maxAttempts: 3, delayMs: 1000 }, ts)
    expect(out[0]).toMatchObject({ status: 'attempt' })
    if (out[0]?.status === 'attempt') {
      expect(out[0].attemptData.reason).toBe('重试中')
    }
  })

  test('auto_retry_end success=true -> cleared', () => {
    const out = mapPiNativeRetryEvent({ type: 'auto_retry_end', success: true, attempt: 2, maxAttempts: 3, delayMs: 0 }, ts)
    expect(out).toEqual([{ status: 'cleared' }])
  })

  test('auto_retry_end outcome=succeeded -> cleared（即使 success/outcome 并存）', () => {
    const out = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: true, outcome: 'succeeded', attempt: 2, maxAttempts: 3, delayMs: 0 },
      ts,
    )
    expect(out).toEqual([{ status: 'cleared' }])
  })

  test('auto_retry_end 无 success 标注但 outcome=succeeded -> cleared', () => {
    const out = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: false, outcome: 'succeeded', attempt: 2, maxAttempts: 3, delayMs: 0, finalError: 'x' },
      ts,
    )
    expect(out).toEqual([{ status: 'cleared' }])
  })

  test('auto_retry_end outcome=cancelled -> cleared（不误报 failed）', () => {
    const out = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: false, outcome: 'cancelled', attempt: 3, maxAttempts: 3, delayMs: 0, finalError: 'aborted' },
      ts,
    )
    expect(out).toEqual([{ status: 'cleared' }])
  })

  test('auto_retry_end 真正失败 -> failed', () => {
    const out = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: false, attempt: 3, maxAttempts: 3, delayMs: 0, finalError: 'exhausted' },
      ts,
    )
    expect(out).toEqual([{
      status: 'failed',
      attemptData: { attempt: 3, timestamp: ts, reason: 'exhausted', errorMessage: 'exhausted', delaySeconds: 0 },
    }])
  })
})

describe('createPiRetryTerminalGate', () => {
  test('settle(true) 不透传错误（willRetry 时保留，用于后续 continue）', () => {
    const gate = createPiRetryTerminalGate<string>()
    gate.defer('boom')
    expect(gate.settle(true)).toBeUndefined()
    // poke 应仍能看到？settle(true) 语义：终态不透传但可能保留给后续。
  })

  test('settle(false) 透传错误', () => {
    const gate = createPiRetryTerminalGate<string>()
    gate.defer('boom')
    expect(gate.settle(false)).toBe('boom')
    // settle 会清空
    expect(gate.settle(false)).toBeUndefined()
  })

  test('peek 可见当前挂起错误且不清空', () => {
    const gate = createPiRetryTerminalGate<string>()
    gate.defer('boom')
    expect(gate.peek()).toBe('boom')
    expect(gate.settle(false)).toBe('boom')
    expect(gate.peek()).toBeUndefined()
  })
})
