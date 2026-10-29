import { describe, expect, test } from 'bun:test'
import {
  HOVER_INTENT_MOVE_TOLERANCE,
  isHoverIntentMove,
  resolveSessionHoverPreviewEnabled,
} from './session-preview-intent'

describe('会话悬浮预览：悬停意图', () => {
  test('没有起点时不算移动，交给 mouseenter 重新采样', () => {
    expect(isHoverIntentMove(null, { x: 10, y: 10 })).toBe(false)
  })

  test('容差内的小抖动不打断计时（手抖不会让预览永远不弹）', () => {
    const origin = { x: 100, y: 100 }
    expect(isHoverIntentMove(origin, { x: 100 + HOVER_INTENT_MOVE_TOLERANCE, y: 100 })).toBe(false)
    expect(isHoverIntentMove(origin, { x: 100, y: 100 - HOVER_INTENT_MOVE_TOLERANCE })).toBe(false)
  })

  test('超过容差视为路过，需要重新计时', () => {
    const origin = { x: 100, y: 100 }
    expect(isHoverIntentMove(origin, { x: 100 + HOVER_INTENT_MOVE_TOLERANCE + 1, y: 100 })).toBe(true)
    // 斜向位移按欧氏距离判定
    expect(isHoverIntentMove(origin, { x: 110, y: 110 })).toBe(true)
  })
})

describe('会话悬浮预览：设置归一', () => {
  test('缺省（旧配置 / 读失败）保持开启', () => {
    expect(resolveSessionHoverPreviewEnabled(undefined)).toBe(true)
    expect(resolveSessionHoverPreviewEnabled(null)).toBe(true)
    expect(resolveSessionHoverPreviewEnabled({})).toBe(true)
  })

  test('只有显式 false 才关闭', () => {
    expect(resolveSessionHoverPreviewEnabled({ sessionHoverPreviewEnabled: false })).toBe(false)
    expect(resolveSessionHoverPreviewEnabled({ sessionHoverPreviewEnabled: true })).toBe(true)
  })
})
