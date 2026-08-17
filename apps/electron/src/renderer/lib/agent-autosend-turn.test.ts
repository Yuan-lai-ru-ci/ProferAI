import { describe, expect, test } from 'bun:test'
import { evaluateAutoSendTurn } from './agent-autosend-turn'
import type { AutoSendTurnState } from './agent-autosend-turn'

function baseState(overrides: Partial<AutoSendTurnState> = {}): AutoSendTurnState {
  return {
    turnVersion: 0,
    consumedVersion: 0,
    autoSendEnabled: true,
    queuedCount: 0,
    liveMessagesPending: false,
    streaming: false,
    stoppedByUser: false,
    canSendQueuedNow: true,
    ...overrides,
  }
}

describe('evaluateAutoSendTurn 轮结束自动发送决策', () => {
  test('回归：空队列结束后再入队不发送（轮结束信号不残留）', () => {
    // 第一轮结束，队列为空 → 消费版本号，防止陈旧信号残留
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 0 }))).toBe('consume')
    // 模拟消费后 consumed=1，此时右键入队（queuedCount=1）→ 已无未消费轮结束 → 不发送
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1, queuedCount: 1 }))).toBe('idle')
  })

  test('回归：关闭时结束后再打开不发送（轮结束信号不残留）', () => {
    // 开关关，第一轮结束 → 消费版本号，防止陈旧信号残留
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, autoSendEnabled: false }))).toBe('consume')
    // 模拟消费后 consumed=1，此时打开开关 → 已无未消费轮结束 → 不发送
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1, autoSendEnabled: true, queuedCount: 1 }))).toBe('idle')
  })

  test('正常发送：轮结束 + 队列非空 + 可发送 → send', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1 }))).toBe('send')
  })

  test('live 未清空：等待上轮执行进入 persisted，不消费版本号 → defer', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, liveMessagesPending: true }))).toBe('defer')
  })

  test('streaming / stoppedByUser / 不可发送：发送机会已过，消费版本号 → consume', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, streaming: true }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, stoppedByUser: true }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, canSendQueuedNow: false }))).toBe('consume')
  })

  test('无未消费版本（consumed >= turnVersion）→ idle', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1, queuedCount: 1 }))).toBe('idle')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 0, consumedVersion: 0 }))).toBe('idle')
  })
})
