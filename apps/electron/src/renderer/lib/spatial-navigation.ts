import type { NavigationAction } from './navigation-actions'

export interface SpatialNavigationRect {
  left: number
  top: number
  width: number
  height: number
}

export interface SpatialNavigationItem {
  id: string
  rect: SpatialNavigationRect
}

type SpatialDirection = Extract<NavigationAction, 'previous' | 'next' | 'left' | 'right'>

function center(rect: SpatialNavigationRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** Finds the visually nearest eligible target, favoring alignment on the requested axis. */
export function findSpatialNavigationTarget(
  origin: SpatialNavigationItem,
  items: readonly SpatialNavigationItem[],
  direction: SpatialDirection,
): SpatialNavigationItem | undefined {
  const originCenter = center(origin.rect)
  let best: { item: SpatialNavigationItem; score: number } | undefined

  for (const item of items) {
    if (item.id === origin.id) continue
    const candidateCenter = center(item.rect)
    const dx = candidateCenter.x - originCenter.x
    const dy = candidateCenter.y - originCenter.y
    const isHorizontal = direction === 'left' || direction === 'right'
    const inDirection = direction === 'left' ? dx < 0
      : direction === 'right' ? dx > 0
        : direction === 'previous' ? dy < 0
          : dy > 0
    if (!inDirection) continue

    const primary = isHorizontal ? Math.abs(dx) : Math.abs(dy)
    const crossAxis = isHorizontal ? Math.abs(dy) : Math.abs(dx)
    // A strong cross-axis penalty favors items that are actually adjacent on screen.
    const score = primary + crossAxis * 3
    if (!best || score < best.score) best = { item, score }
  }

  return best?.item
}
