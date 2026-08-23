import { expect, test } from 'bun:test'
import { resolveBrowserViewportLayout, shouldApplyBrowserLayoutRevision } from './browser-view-layout'

test('将 CSS viewport 边界只缩放一次并裁到 contentView 内', () => {
  expect(resolveBrowserViewportLayout(
    { x: 100, y: 80, width: 600, height: 700 },
    1.25,
    { width: 800, height: 700 },
  )).toEqual({ x: 125, y: 100, width: 675, height: 600 })
})

test('完全落在窗口外的 viewport 收敛为零宽度', () => {
  expect(resolveBrowserViewportLayout(
    { x: 900, y: 20, width: 200, height: 100 },
    1,
    { width: 800, height: 700 },
  )).toEqual({ x: 800, y: 20, width: 0, height: 100 })
})

test('仅接受严格递增的布局代际', () => {
  expect(shouldApplyBrowserLayoutRevision(12, 12)).toBeFalse()
  expect(shouldApplyBrowserLayoutRevision(12, 11)).toBeFalse()
  expect(shouldApplyBrowserLayoutRevision(12, 13)).toBeTrue()
})
