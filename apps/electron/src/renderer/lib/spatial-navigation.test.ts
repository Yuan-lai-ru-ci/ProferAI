import { describe, expect, test } from 'bun:test'
import { findSpatialNavigationTarget, type SpatialNavigationItem } from './spatial-navigation'

const item = (id: string, x: number, y: number): SpatialNavigationItem => ({
  id,
  rect: { left: x, top: y, width: 20, height: 20 },
})

describe('findSpatialNavigationTarget', () => {
  test('selects the nearest item that lies in the requested direction', () => {
    const origin = item('origin', 100, 100)
    const items = [origin, item('left', 20, 105), item('above', 105, 20), item('right', 220, 110)]

    expect(findSpatialNavigationTarget(origin, items, 'left')?.id).toBe('left')
    expect(findSpatialNavigationTarget(origin, items, 'previous')?.id).toBe('above')
    expect(findSpatialNavigationTarget(origin, items, 'right')?.id).toBe('right')
  })

  test('prefers alignment with the requested axis over a farther diagonal item', () => {
    const origin = item('origin', 100, 100)
    const items = [origin, item('diagonal', 130, 20), item('aligned', 260, 105)]

    expect(findSpatialNavigationTarget(origin, items, 'right')?.id).toBe('aligned')
  })

  test('returns undefined when no item exists in that direction', () => {
    const origin = item('origin', 100, 100)
    expect(findSpatialNavigationTarget(origin, [origin, item('below', 100, 200)], 'previous')).toBeUndefined()
  })
})
