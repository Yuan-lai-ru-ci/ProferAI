import { describe, expect, test } from 'bun:test'
import {
  buildCurrentSessionMaxHeight,
  CURRENT_SESSION_MIN_MAX_HEIGHT_PX,
  CURRENT_SESSION_RESERVED_VIEWPORT_PX,
  CURRENT_SESSION_ROW_HEIGHT_PX,
  DEFAULT_CURRENT_SESSION_VISIBLE_COUNT,
  MAX_CURRENT_SESSION_VISIBLE_COUNT,
  MIN_CURRENT_SESSION_VISIBLE_COUNT,
  normalizeCurrentSessionVisibleCount,
  resolveEffectiveVisibleRows,
} from './current-session-capacity'

describe('normalizeCurrentSessionVisibleCount — 自由输入只做数值钳制', () => {
  test('Given 缺省或非数值 When 归一化 Then 回落到默认 5', () => {
    expect(DEFAULT_CURRENT_SESSION_VISIBLE_COUNT).toBe(5)
    for (const value of [undefined, null, '7', '', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normalizeCurrentSessionVisibleCount(value)).toBe(5)
    }
  })

  test('Given 任意合法正整数 When 归一化 Then 原样保留，不受档位限制', () => {
    for (const value of [1, 2, 6, 7, 11, 17, 30]) {
      expect(normalizeCurrentSessionVisibleCount(value)).toBe(value)
    }
  })

  test('Given 越界或小数 When 归一化 Then 四舍五入并钳制到 [1, 30]', () => {
    expect(normalizeCurrentSessionVisibleCount(0)).toBe(MIN_CURRENT_SESSION_VISIBLE_COUNT)
    expect(normalizeCurrentSessionVisibleCount(-5)).toBe(MIN_CURRENT_SESSION_VISIBLE_COUNT)
    expect(normalizeCurrentSessionVisibleCount(100)).toBe(MAX_CURRENT_SESSION_VISIBLE_COUNT)
    expect(normalizeCurrentSessionVisibleCount(7.6)).toBe(8)
  })
})

describe('buildCurrentSessionMaxHeight — N 是上限而非目标高度', () => {
  test('Given 上限 12 When 生成表达式 Then 同时被 N 行、视口剩余空间与硬下限夹住', () => {
    const css = buildCurrentSessionMaxHeight(12)
    expect(css.startsWith('min(')).toBe(true)
    expect(css).toContain(`calc(12 * ${CURRENT_SESSION_ROW_HEIGHT_PX}px)`)
    expect(css).toContain(`calc(100vh - ${CURRENT_SESSION_RESERVED_VIEWPORT_PX}px)`)
    expect(css).toContain(`${CURRENT_SESSION_MIN_MAX_HEIGHT_PX}px`)
  })

  test('Given 极大值 When 生成表达式 Then 钳到 30 行且不产生 NaN', () => {
    const css = buildCurrentSessionMaxHeight(9999)
    expect(css).toBe(buildCurrentSessionMaxHeight(MAX_CURRENT_SESSION_VISIBLE_COUNT))
    expect(css).not.toContain('NaN')
  })

  test('Given 用户自由输入 7 When 生成表达式 Then 表达式确实用 7 行', () => {
    expect(buildCurrentSessionMaxHeight(7)).toContain(`calc(7 * ${CURRENT_SESSION_ROW_HEIGHT_PX}px)`)
  })

  test('Given 非数值 When 生成表达式 Then 回落到默认 5 行', () => {
    expect(buildCurrentSessionMaxHeight(Number.NaN)).toContain(
      `calc(${DEFAULT_CURRENT_SESSION_VISIBLE_COUNT} * ${CURRENT_SESSION_ROW_HEIGHT_PX}px)`,
    )
  })
})

describe('resolveEffectiveVisibleRows — 设置页提示与侧栏夹算同源', () => {
  test('Given 高窗口 When 计算 Then 实际可见行数等于上限', () => {
    expect(resolveEffectiveVisibleRows(5, 1200)).toBe(5)
    expect(resolveEffectiveVisibleRows(7, 1200)).toBe(7)
    expect(resolveEffectiveVisibleRows(12, 1200)).toBe(12)
  })

  test('Given 矮窗口 When 计算 Then 可见行数被夹住且至少 1 行', () => {
    expect(resolveEffectiveVisibleRows(20, 600)).toBeLessThan(20)
    expect(resolveEffectiveVisibleRows(20, 200)).toBeGreaterThanOrEqual(1)
  })

  test('Given 非有限窗口高度 When 计算 Then 不产生 NaN', () => {
    expect(Number.isFinite(resolveEffectiveVisibleRows(12, Number.NaN))).toBe(true)
  })
})
