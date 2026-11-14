import { describe, expect, test } from 'bun:test'
import {
  MANUAL_HANDOFF_TOOLTIP,
  resolveManualHandoffState,
  type ManualHandoffInput,
} from './session-handoff-trigger'

const READY: ManualHandoffInput = {
  sessionReady: true,
  hasContent: true,
  running: false,
  inFlight: false,
}

const resolve = (patch: Partial<ManualHandoffInput>) =>
  resolveManualHandoffState({ ...READY, ...patch })

describe('手动会话交接可用态', () => {
  test('Given 会话空闲且有内容 When 判定 Then 可用', () => {
    expect(resolve({})).toEqual({ enabled: true, hint: null, reason: null })
  })

  test('Given 建议条的所有触发条件都不满足 When 判定 Then 手动入口仍可用', () => {
    // 手动入口刻意不接收 threshold / contextRatio / dismissed：
    // 设置关闭、上下文很空、用户点过「不再提示」都不该挡住主动触发。
    const withSuggestionFields = {
      ...READY,
      threshold: 0,
      contextRatio: 0,
      dismissed: true,
    }
    expect(resolveManualHandoffState(withSuggestionFields)).toEqual({
      enabled: true,
      hint: null,
      reason: null,
    })
  })

  test('Given 确认弹窗已说明代价 When 取启用态 hover 文案 Then 只保留按钮名', () => {
    // 长说明搬进确认框后，hover 重复一遍只会变成噪音；禁用态另有 hint 解释原因。
    expect(MANUAL_HANDOFF_TOOLTIP).toBe('交接并新开会话')
    expect(MANUAL_HANDOFF_TOOLTIP).not.toContain('自动切到新会话')
    expect(MANUAL_HANDOFF_TOOLTIP).not.toContain('交接文档')
  })

  test('Given 已有交接在飞 When 判定 Then 禁用并提示进行中', () => {
    const state = resolve({ inFlight: true })
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('inFlight')
  })

  test('Given 本会话正在运行 When 判定 Then 禁用（同一份 JSONL 不能两个写者）', () => {
    const state = resolve({ running: true })
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('running')
  })

  test('Given 消息还没加载完 When 判定 Then 禁用', () => {
    expect(resolve({ sessionReady: false }).reason).toBe('loading')
  })

  test('Given 空会话 When 判定 Then 禁用（没有可交接的内容）', () => {
    expect(resolve({ hasContent: false }).reason).toBe('empty')
  })

  test('Given 任一禁用理由 When 判定 Then 都带可读提示（灰按钮的原因要能显示出来）', () => {
    // 禁用态的 Radix Tooltip 挂不上 disabled button，按钮靠 hint 做原生 title 兜底；
    // 哪个分支忘了写 hint，用户就只看到一个没有解释的灰按钮。
    for (const patch of [
      { inFlight: true },
      { running: true },
      { sessionReady: false },
      { hasContent: false },
    ]) {
      const state = resolve(patch)
      expect(state.enabled).toBe(false)
      expect(state.hint?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('Given 在飞且运行态同时为真 When 判定 Then 在飞理由优先', () => {
    expect(resolve({ inFlight: true, running: true }).reason).toBe('inFlight')
  })

  test('Given 未加载且没有内容 When 判定 Then 加载理由优先', () => {
    expect(resolve({ sessionReady: false, hasContent: false }).reason).toBe('loading')
  })
})
