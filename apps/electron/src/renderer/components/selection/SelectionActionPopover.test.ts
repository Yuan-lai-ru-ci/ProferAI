import { describe, expect, test } from 'bun:test'
import { computeViewportShift } from './SelectionActionPopover'

describe('computeViewportShift', () => {
  test('按钮完全在视口内时不平移', () => {
    expect(computeViewportShift({ left: 100, top: 100, width: 120, height: 44 }, 1280, 800)).toEqual({ dx: 0, dy: 0 })
  })

  test('顶部越界时向下平移回视口内', () => {
    expect(computeViewportShift({ left: 100, top: -30, width: 120, height: 44 }, 1280, 800)).toEqual({ dx: 0, dy: 30 })
  })

  test('左侧越界时向右平移回视口内', () => {
    expect(computeViewportShift({ left: -10, top: 100, width: 120, height: 44 }, 1280, 800)).toEqual({ dx: 10, dy: 0 })
  })

  test('右侧越界时向左平移回视口内', () => {
    expect(computeViewportShift({ left: 1200, top: 100, width: 120, height: 44 }, 1280, 800)).toEqual({ dx: -40, dy: 0 })
  })

  test('底部越界时向上平移回视口内', () => {
    expect(computeViewportShift({ left: 100, top: 780, width: 120, height: 44 }, 1280, 800)).toEqual({ dx: 0, dy: -24 })
  })

  test('按钮宽于视口时钳制到视口左缘', () => {
    expect(computeViewportShift({ left: -50, top: 100, width: 1400, height: 44 }, 1280, 800)).toEqual({ dx: 50, dy: 0 })
  })

  test('与底部禁区重叠时右移到禁区右侧并留空隙', () => {
    const avoid = { left: 622, top: 738, width: 36, height: 36 }
    const rect = { left: 600, top: 720, width: 120, height: 44 }
    expect(computeViewportShift(rect, 1280, 800, avoid)).toEqual({ dx: 70, dy: 0 })
  })

  test('不与禁区重叠时保持原钳制不动', () => {
    const avoid = { left: 622, top: 738, width: 36, height: 36 }
    const rect = { left: 100, top: 100, width: 120, height: 44 }
    expect(computeViewportShift(rect, 1280, 800, avoid)).toEqual({ dx: 0, dy: 0 })
  })

  test('与禁区重叠时右移到禁区右侧（含空隙）', () => {
    const avoid = { left: 0, top: 0, width: 36, height: 36 }
    const rect = { left: 10, top: 0, width: 120, height: 44 }
    expect(computeViewportShift(rect, 1280, 800, avoid)).toEqual({ dx: 38, dy: 0 })
  })

  test('禁区靠右导致右移超视口时钳制到视口右缘', () => {
    const avoid = { left: 1200, top: 100, width: 36, height: 36 }
    const rect = { left: 1150, top: 100, width: 120, height: 44 }
    expect(computeViewportShift(rect, 1280, 800, avoid)).toEqual({ dx: 10, dy: 0 })
  })
})
