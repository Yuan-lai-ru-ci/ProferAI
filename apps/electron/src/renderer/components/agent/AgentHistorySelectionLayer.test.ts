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
    expect(pickSelectionAnchor(rect(), 130).x).toBe(200)
  })

  test('抬手点在选区下半部（从上往下选）时按钮向下展开、留出间距', () => {
    // centerY = 130，pointerY = 150 >= 130 → direction down，y = 150 + 24 = 174
    expect(pickSelectionAnchor(rect(), 150)).toEqual({ x: 200, y: 174, direction: 'down' })
  })

  test('抬手点在选区上半部（从下往上选）时按钮向上展开、留出间距', () => {
    // centerY = 130，pointerY = 110 < 130 → direction up，y = 110 - 24 = 86
    expect(pickSelectionAnchor(rect(), 110)).toEqual({ x: 200, y: 86, direction: 'up' })
  })

  test('键盘选择无抬手点（pointerY 为 null）时退回选区底部、向上展开', () => {
    // y = 160 - 24 = 136
    expect(pickSelectionAnchor(rect(), null)).toEqual({ x: 200, y: 136, direction: 'up' })
  })
})
