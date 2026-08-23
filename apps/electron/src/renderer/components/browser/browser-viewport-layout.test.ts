import { expect, test } from 'bun:test'
import { resolveNativeBrowserVisible, sameBrowserViewportLayout } from './browser-viewport-layout'

const layout = {
  sessionId: 'session-1',
  tabId: 'tab-1',
  revision: 1,
  visible: true,
  viewportBounds: { x: 200, y: 100, width: 600, height: 500 },
  viewportRadius: 16,
  pageBounds: { x: 0, y: 0, width: 600, height: 500 },
}

test('CSS 隐藏面板时即使盒模型尺寸未变化，也必须隐藏原生视图', () => {
  expect(resolveNativeBrowserVisible(false, false)).toBeFalse()
  expect(resolveNativeBrowserVisible(true, true)).toBeFalse()
  expect(resolveNativeBrowserVisible(true, false)).toBeTrue()
})

test('相同几何与可见性不重复发布 native layout', () => {
  expect(sameBrowserViewportLayout(layout, { ...layout, revision: 2 })).toBeTrue()
})

test('视口、页面、标签和可见性任一变化都会发布', () => {
  expect(sameBrowserViewportLayout(layout, { ...layout, visible: false })).toBeFalse()
  expect(sameBrowserViewportLayout(layout, { ...layout, tabId: 'tab-2' })).toBeFalse()
  expect(sameBrowserViewportLayout(layout, { ...layout, viewportBounds: { ...layout.viewportBounds, x: 201 } })).toBeFalse()
  expect(sameBrowserViewportLayout(layout, { ...layout, pageBounds: { ...layout.pageBounds, height: 499 } })).toBeFalse()
})
