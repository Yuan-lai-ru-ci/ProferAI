import { expect, test } from 'bun:test'
import { resolveBrowserPageHostBounds, resolveBrowserViewportLayout, shouldApplyBrowserLayoutRevision } from './browser-view-layout'

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

test('网页 host 只覆盖 frame 内的 pageBounds，而不是整张浏览器卡片', () => {
  expect(resolveBrowserPageHostBounds(
    { x: 100, y: 200, width: 800, height: 600 },
    { x: 12, y: 96, width: 788, height: 504 },
  )).toEqual({ x: 112, y: 296, width: 788, height: 504 })
})

test('仅接受严格递增的布局代际', () => {
  expect(shouldApplyBrowserLayoutRevision(12, 12)).toBeFalse()
  expect(shouldApplyBrowserLayoutRevision(12, 11)).toBeFalse()
  expect(shouldApplyBrowserLayoutRevision(12, 13)).toBeTrue()
})
