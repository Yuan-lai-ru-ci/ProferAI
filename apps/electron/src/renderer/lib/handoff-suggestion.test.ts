import { describe, expect, test } from 'bun:test'
import {
  HANDOFF_CONTEXT_PRESSURE_RATIO,
  resolveHandoffSuggestion,
  type HandoffSuggestionInput,
} from './handoff-suggestion'

const BASE: HandoffSuggestionInput = {
  turnCount: 0,
  threshold: 30,
  contextRatio: 0.2,
  streaming: false,
  dismissed: false,
  inFlight: false,
}

const resolve = (patch: Partial<HandoffSuggestionInput>) =>
  resolveHandoffSuggestion({ ...BASE, ...patch })

describe('会话交接建议判定', () => {
  test('Given 阈值为 0 When 上下文已占满 Then 仍不显示（关闭态优先于一切）', () => {
    expect(resolve({ threshold: 0, turnCount: 99, contextRatio: 0.98 })).toEqual({
      visible: false,
      reason: null,
    })
  })

  test('Given 未达阈值且上下文正常 When 判定 Then 不显示', () => {
    expect(resolve({ turnCount: 29 })).toEqual({ visible: false, reason: null })
  })

  test('Given 轮数达到阈值 When 判定 Then 以轮数理由显示', () => {
    expect(resolve({ turnCount: 30 })).toEqual({ visible: true, reason: 'turnThreshold' })
  })

  test('Given 正在流式输出 When 判定 Then 不显示（交接要等当前轮结束）', () => {
    expect(resolve({ turnCount: 40, streaming: true })).toEqual({ visible: false, reason: null })
  })

  test('Given 用户已忽略该会话 When 判定 Then 不显示', () => {
    expect(resolve({ turnCount: 40, dismissed: true })).toEqual({ visible: false, reason: null })
  })

  test('Given 该会话交接进行中 When 判定 Then 不显示', () => {
    expect(resolve({ turnCount: 40, inFlight: true })).toEqual({ visible: false, reason: null })
  })

  test('Given 上下文越过告警线且轮数过半 When 判定 Then 提前以上下文理由显示', () => {
    expect(
      resolve({ turnCount: 15, contextRatio: HANDOFF_CONTEXT_PRESSURE_RATIO }),
    ).toEqual({ visible: true, reason: 'contextPressure' })
  })

  test('Given 上下文越线但轮数未过半 When 判定 Then 不显示（此时几乎没有可交接的内容）', () => {
    expect(resolve({ turnCount: 3, contextRatio: 0.95 })).toEqual({
      visible: false,
      reason: null,
    })
  })

  test('Given 阈值很小时 When 上下文越线 Then 至少要有 1 轮才提醒', () => {
    expect(resolve({ threshold: 1, turnCount: 0, contextRatio: 0.95 })).toEqual({
      visible: false,
      reason: null,
    })
    expect(resolve({ threshold: 1, turnCount: 1, contextRatio: 0.95 })).toEqual({
      visible: true,
      reason: 'turnThreshold',
    })
  })

  test('Given 阈值非有限数（脏数据）When 判定 Then 按关闭处理', () => {
    expect(resolve({ threshold: Number.NaN, turnCount: 99 })).toEqual({
      visible: false,
      reason: null,
    })
  })
})
