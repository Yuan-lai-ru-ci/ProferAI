import { describe, expect, test } from 'bun:test'
import { allowsPluginPagePlacement, resolvePluginPageSurfaceVisibility, type ProferPluginPageContribution } from './index'

describe('插件页面入口', () => {
  test('旧清单没有 placements 时保留设置页与 Tab 入口', () => {
    const page: ProferPluginPageContribution = { id: 'main', title: 'Main', entry: 'index.html' }
    expect(allowsPluginPagePlacement(page, 'tab')).toBe(true)
    expect(allowsPluginPagePlacement(page, 'settings')).toBe(true)
  })

  test('显式声明只开放对应入口', () => {
    const page: ProferPluginPageContribution = { id: 'main', title: 'Main', entry: 'index.html', placements: ['tab', 'sidebar'] }
    expect(allowsPluginPagePlacement(page, 'tab')).toBe(true)
    expect(allowsPluginPagePlacement(page, 'sidebar')).toBe(true)
    expect(allowsPluginPagePlacement(page, 'settings')).toBe(false)
  })
})

describe('用户摆放偏好', () => {
  const both: ProferPluginPageContribution = { id: 'main', title: 'Main', entry: 'index.html', placements: ['tab', 'sidebar'] }
  const sidebarOnly: ProferPluginPageContribution = { id: 'main', title: 'Main', entry: 'index.html', placements: ['sidebar'] }

  test('无偏好时按清单行为展示', () => {
    expect(resolvePluginPageSurfaceVisibility(both, undefined, 'sidebar')).toBe(true)
    expect(resolvePluginPageSurfaceVisibility(both, undefined, 'tab')).toBe(true)
  })

  test('hidden 偏好隐藏所有宿主表面入口', () => {
    expect(resolvePluginPageSurfaceVisibility(both, 'hidden', 'sidebar')).toBe(false)
    expect(resolvePluginPageSurfaceVisibility(both, 'hidden', 'tab')).toBe(false)
  })

  test('偏好收窄到单一位置', () => {
    expect(resolvePluginPageSurfaceVisibility(both, 'tab', 'tab')).toBe(true)
    expect(resolvePluginPageSurfaceVisibility(both, 'tab', 'sidebar')).toBe(false)
    expect(resolvePluginPageSurfaceVisibility(both, 'sidebar', 'sidebar')).toBe(true)
    expect(resolvePluginPageSurfaceVisibility(both, 'sidebar', 'tab')).toBe(false)
  })

  test('偏好不能放大清单未声明的入口', () => {
    expect(resolvePluginPageSurfaceVisibility(sidebarOnly, 'tab', 'tab')).toBe(false)
    expect(resolvePluginPageSurfaceVisibility(sidebarOnly, 'tab', 'sidebar')).toBe(true)
  })

  test('偏好指向清单未声明的位置时回退清单行为', () => {
    expect(resolvePluginPageSurfaceVisibility(sidebarOnly, 'tab', 'sidebar')).toBe(true)
    expect(resolvePluginPageSurfaceVisibility(both, 'tab', 'sidebar')).toBe(false)
  })
})
