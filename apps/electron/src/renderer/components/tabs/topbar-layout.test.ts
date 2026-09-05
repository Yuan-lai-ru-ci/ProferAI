import { expect, test } from 'bun:test'
import { resolveTopBarGeometry } from './topbar-layout'

test('顶栏内容行保持 40px 外框与 37px 内容行', () => {
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
