import { describe, expect, test } from 'bun:test'
import { evaluateAutoSendTurn, shouldStartAutoSendFromIdle } from './agent-autosend-turn'
import type { AutoSendTurnState } from './agent-autosend-turn'

function baseState(overrides: Partial<AutoSendTurnState> = {}): AutoSendTurnState {
  return {
    turnVersion: 0,
    consumedVersion: 0,
    queuedCount: 0,
    liveMessagesPending: false,
    streaming: false,
    stoppedByUser: false,
    canSendQueuedNow: true,
    ...overrides,
  }
}

describe('shouldStartAutoSendFromIdle 空闲队列自动启动', () => {
  test('空闲时队列非空且可发送，立即启动队首', () => {
    expect(shouldStartAutoSendFromIdle({
      queuedCount: 1,
      liveMessagesPending: false,
      streaming: false,
      stoppedByUser: false,
      canSendQueuedNow: true,
    })).toBe(true)
  })

  test('运行中、停止态、live 未清空或不可发送时不启动', () => {
    const base = {
      queuedCount: 1,
      liveMessagesPending: false,
      streaming: false,
      stoppedByUser: false,
      canSendQueuedNow: true,
    }
    expect(shouldStartAutoSendFromIdle({ ...base, streaming: true })).toBe(false)
    expect(shouldStartAutoSendFromIdle({ ...base, stoppedByUser: true })).toBe(false)
    expect(shouldStartAutoSendFromIdle({ ...base, liveMessagesPending: true })).toBe(false)
    expect(shouldStartAutoSendFromIdle({ ...base, canSendQueuedNow: false })).toBe(false)
  })
})

describe('evaluateAutoSendTurn 轮结束自动发送决策', () => {
  test('回归：空队列结束后再入队不发送（轮结束信号不残留）', () => {
    // 第一轮结束，队列为空 → 消费版本号，防止陈旧信号残留
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 0 }))).toBe('consume')
    // 模拟消费后 consumed=1，此时右键入队（queuedCount=1）→ 已无未消费轮结束 → 不发送
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1, queuedCount: 1 }))).toBe('idle')
  })

  test('正常发送：轮结束 + 队列非空 + 可发送 → send', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1 }))).toBe('send')
  })

  test('运行中开启后：当前轮结束产生新版本，队列立即获得自动发送资格', () => {
    // 当前 Agent 仍在运行；此前没有未消费的轮结束事件。
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 3, consumedVersion: 3, queuedCount: 1 }))).toBe('idle')
    // 当前轮结束后 version +1，不需要额外手动发送一轮。
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 4, consumedVersion: 3, queuedCount: 1 }))).toBe('send')
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
