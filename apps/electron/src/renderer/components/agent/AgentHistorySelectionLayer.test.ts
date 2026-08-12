import { describe, expect, test } from 'bun:test'
import { pickAnchorRect, type SelectionRect } from './AgentHistorySelectionLayer'

function rect(overrides: Partial<SelectionRect> = {}): SelectionRect {
  return {
    left: 100,
    top: 100,
    right: 200,
    bottom: 120,
    width: 100,
    ...overrides,
  }
}

describe('pickAnchorRect', () => {
  test('全部可见时取最后一个矩形（贴近鼠标落点）', () => {
    const rects = [rect(), rect({ left: 300, right: 400 }), rect({ left: 600, right: 700 })]
    expect(pickAnchorRect(rects, 1280, 800)).toBe(rects[2]!)
  })

  test('跨屏选区（顶部已滚出视口）时取最后一个仍可见的矩形', () => {
    const rects = [
      rect({ top: -500, bottom: -480 }),
      rect({ top: -400, bottom: -380 }),
      rect({ top: 100, bottom: 120 }),
    ]
    expect(pickAnchorRect(rects, 1280, 800)).toBe(rects[2]!)
  })

  test('全部不可见（都滚出视口）时回退到第一个矩形', () => {
    const rects = [rect({ top: -500, bottom: -480 }), rect({ top: -400, bottom: -380 })]
    expect(pickAnchorRect(rects, 1280, 800)).toBe(rects[0]!)
  })

  test('视口右侧之外的矩形不会被选中（优先选可见的）', () => {
    const rects = [rect({ left: 1300, right: 1400 }), rect({ top: 100, bottom: 120 })]
    expect(pickAnchorRect(rects, 1280, 800)).toBe(rects[1]!)
  })

  test('空列表返回 null', () => {
    expect(pickAnchorRect([], 1280, 800)).toBeNull()
  })
})
