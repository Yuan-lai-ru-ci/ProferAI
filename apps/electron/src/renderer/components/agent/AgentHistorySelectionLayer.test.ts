import { describe, expect, test } from 'bun:test'
import { pickSelectionAnchor, type SelectionRect } from './AgentHistorySelectionLayer'

function rect(overrides: Partial<SelectionRect> = {}): SelectionRect {
  return {
    left: 100,
    top: 100,
    right: 300,
    bottom: 160,
    width: 200,
    ...overrides,
  }
}

describe('pickSelectionAnchor', () => {
  test('水平始终居中于选区包围盒中心', () => {
    expect(pickSelectionAnchor(rect(), 160)).toEqual({ x: 200, y: 160 })
  })

  test('垂直优先取鼠标抬手点（松手必在视口内）', () => {
    // 抬手点在上方（从下往上选择），垂直对齐抬手点而不是选区底部
    expect(pickSelectionAnchor(rect(), 40)).toEqual({ x: 200, y: 40 })
  })

  test('键盘选择无抬手点（pointerY 为 null）时退回选区底部', () => {
    expect(pickSelectionAnchor(rect(), null)).toEqual({ x: 200, y: 160 })
  })

  test('跨屏选区（top 滚出视口）时水平中心仍取选区中点', () => {
    const r = rect({ top: -500, bottom: 120, left: -100, right: 300, width: 400 })
    expect(pickSelectionAnchor(r, 120)).toEqual({ x: 100, y: 120 })
  })
})
