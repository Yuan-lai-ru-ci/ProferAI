import { expect, test } from 'bun:test'
import { MAC_TOPBAR_CONTENT_HEIGHT, MAC_TOPBAR_HEIGHT, MAC_TOPBAR_TOP_INSET, resolveTopBarGeometry } from './topbar-layout'

test('Mac 全局 chrome 为 53px，37px 内容行上下各保留 8px', () => {
  expect(MAC_TOPBAR_HEIGHT).toBe(53)
  expect(MAC_TOPBAR_CONTENT_HEIGHT).toBe(37)
  expect(MAC_TOPBAR_TOP_INSET).toBe(8)
  expect(resolveTopBarGeometry({
    frameHeight: MAC_TOPBAR_HEIGHT,
    contentHeight: MAC_TOPBAR_CONTENT_HEIGHT,
    brandWidth: 0,
    actionWidth: 104,
    availableWidth: 1200,
  })).toMatchObject({
    frameHeight: 53,
    contentHeight: 37,
    verticalGutter: 8,
  })
})

test('普通顶栏内容行提高到 37px并保持 40px 外框', () => {
  expect(resolveTopBarGeometry({ brandWidth: 32, actionWidth: 96, availableWidth: 800 })).toEqual({
    frameHeight: 40,
    contentHeight: 37,
    verticalGutter: 1.5,
    tabsViewportWidth: 672,
  })
})

test('操作区宽度只影响 Tab 横向视口，不影响垂直居中', () => {
  const withoutActions = resolveTopBarGeometry({ brandWidth: 32, actionWidth: 0, availableWidth: 800 })
  const withActions = resolveTopBarGeometry({ brandWidth: 32, actionWidth: 160, availableWidth: 800 })

  expect(withoutActions.verticalGutter).toBe(withActions.verticalGutter)
  expect(withActions.tabsViewportWidth).toBe(608)
})

test('异常尺寸不会产生负内边距或负视口', () => {
  expect(resolveTopBarGeometry({ frameHeight: 20, contentHeight: 32, brandWidth: 100, actionWidth: 100, availableWidth: 50 })).toEqual({
    frameHeight: 20,
    contentHeight: 20,
    verticalGutter: 0,
    tabsViewportWidth: 0,
  })
})
