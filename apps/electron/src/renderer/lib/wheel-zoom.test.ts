import { describe, expect, test } from 'bun:test'
import {
  applyWheelZoom,
  normalizeWheelDelta,
  wheelZoomMultiplier,
  DEFAULT_WHEEL_ZOOM,
} from './wheel-zoom'

// 模拟 WheelEvent 的最小形状
const ev = (deltaY: number, deltaMode = 0): { deltaY: number; deltaMode: number } => ({
  deltaY,
  deltaMode,
})

describe('normalizeWheelDelta', () => {
  test('像素模式原样返回', () => {
    expect(normalizeWheelDelta(ev(120, 0))).toBe(120)
    expect(normalizeWheelDelta(ev(-3, 0))).toBe(-3)
  })
  test('行模式换算为像素', () => {
    expect(normalizeWheelDelta(ev(3, 1))).toBe(99)
  })
  test('页模式换算为像素', () => {
    expect(normalizeWheelDelta(ev(1, 2))).toBe(400)
  })
})

describe('wheelZoomMultiplier（panzoom 模型）', () => {
  test('鼠标滚轮一格（120）约放大 6%', () => {
    const m = wheelZoomMultiplier(ev(-120))
    expect(m).toBeGreaterThan(1)
    expect(m).toBeLessThan(1.1)
  })

  test('鼠标向下滚一格缩小', () => {
    const m = wheelZoomMultiplier(ev(120))
    expect(m).toBeLessThan(1)
    expect(m).toBeGreaterThan(0.9)
  })

  test('单步缩放幅度被钳制，猛滚不会一步翻倍', () => {
    // 极大的 delta（例如某些触控板/驱动上报的大值）
    const m = wheelZoomMultiplier(ev(-10000))
    expect(m).toBeLessThanOrEqual(1 + DEFAULT_WHEEL_ZOOM.maxStep)
    const m2 = wheelZoomMultiplier(ev(10000))
    expect(m2).toBeGreaterThanOrEqual(1 - DEFAULT_WHEEL_ZOOM.maxStep)
  })

  test('触控板捏合小增量 → 小步缩放（平滑）', () => {
    const m = wheelZoomMultiplier(ev(-2))
    // delta=2 → step = 0.065*2/128 ≈ 0.001 → m ≈ 1.001
    expect(m).toBeGreaterThan(1)
    expect(m).toBeLessThan(1.005)
  })

  test('delta 为 0 时乘数为 1', () => {
    expect(wheelZoomMultiplier(ev(0))).toBe(1)
  })

  test('缩放方向：负 delta（向上/捏合张开）放大', () => {
    expect(wheelZoomMultiplier(ev(-50))).toBeGreaterThan(1)
    expect(wheelZoomMultiplier(ev(50))).toBeLessThan(1)
  })
})

describe('applyWheelZoom', () => {
  test('在当前缩放基础上累乘并钳到上下限', () => {
    expect(applyWheelZoom(1, ev(-120))).toBeGreaterThan(1)
    // 不会低于 minZoom
    expect(applyWheelZoom(0.5, ev(120), { minZoom: 0.5 })).toBe(0.5)
    // 不会高于 maxZoom
    expect(applyWheelZoom(5, ev(-120), { maxZoom: 5 })).toBe(5)
  })

  test('一格滚轮永远不会让缩放一步跳到 2 倍', () => {
    const next = applyWheelZoom(1, ev(-120))
    expect(next).toBeLessThan(1.2)
  })
})
