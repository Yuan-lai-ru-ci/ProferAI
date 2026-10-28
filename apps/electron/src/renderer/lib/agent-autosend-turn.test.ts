import { describe, expect, test } from 'bun:test'

import { AUTO_SEND_RETRY_INTERVAL_MS, nextAutoSendRetryAt, shouldAutoSendQueueHead, type AutoSendGateState } from './agent-autosend-turn'

const gate = (over: Partial<AutoSendGateState> = {}): AutoSendGateState => ({
  autoSendEnabled: true,
  queuedCount: 1,
  liveMessagesPending: false,
  streaming: false,
  stoppedByUser: false,
  canSendQueuedNow: true,
  sendInFlight: false,
  lastFailureAt: 0,
  now: 1_000,
  ...over,
})

describe('队列自动发送判定', () => {
  test('Given 开关开且空闲可发 When 队列非空 Then 发队首', () => {
    expect(shouldAutoSendQueueHead(gate())).toBe(true)
  })

  test('Given 任一前置不满足 When 判定 Then 都不发', () => {
    expect(shouldAutoSendQueueHead(gate({ autoSendEnabled: false }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ queuedCount: 0 }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ streaming: true }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ liveMessagesPending: true }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ stoppedByUser: true }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ canSendQueuedNow: false }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ sendInFlight: true }))).toBe(false)
  })

  test('Given 上次发送失败 When 退避窗口内 Then 不重试；窗口过后自动重试', () => {
    const failedAt = 1_000
    expect(shouldAutoSendQueueHead(gate({ lastFailureAt: failedAt, now: failedAt + 100 }))).toBe(false)
    expect(shouldAutoSendQueueHead(gate({ lastFailureAt: failedAt, now: failedAt + AUTO_SEND_RETRY_INTERVAL_MS }))).toBe(true)
  })

  test('Given 未失败过 When 询问下次重试时间 Then 为 0', () => {
    expect(nextAutoSendRetryAt({ lastFailureAt: 0 })).toBe(0)
    expect(nextAutoSendRetryAt({ lastFailureAt: 1_000 })).toBe(1_000 + AUTO_SEND_RETRY_INTERVAL_MS)
  })

  test('旧实现的一次性「轮结束版本号」不再参与判定：同一状态下重复判定结果恒等', () => {
    const state = gate()
    const first = shouldAutoSendQueueHead(state)
    const second = shouldAutoSendQueueHead(state)
    expect(first).toBe(true)
    expect(second).toBe(first)
  })
})
