import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SIDEBAR_PANEL_TOP } from './left-sidebar/navigation-items'
import { TOPBAR_HEIGHT } from '../tabs/topbar-layout'

const sidebar = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
const rail = readFileSync(new URL('./left-sidebar/rail.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../styles/globals.css', import.meta.url), 'utf8')

describe('侧栏 rail 吸附预览接线', () => {
  test('侧栏顶部留白与整个顶栏底边对齐，包含内容行下方的留白', () => {
    expect(SIDEBAR_PANEL_TOP).toBe(8 + TOPBAR_HEIGHT)
    expect(SIDEBAR_PANEL_TOP).toBe(48)
    const offsetHook = readFileSync(new URL('./left-sidebar/use-tabbar-offset.ts', import.meta.url), 'utf8')
    expect(offsetHook).toContain("document.querySelector<HTMLElement>('.topbar-editorial')")
    expect(offsetHook).toContain('tabbar.getBoundingClientRect().bottom')
    expect(offsetHook).toContain('observer.observe(tabbar)')
    expect(offsetHook).not.toContain('[data-profer-tabbar-content]')
    // Windows 不需要红绿灯留白，维持既有的顶端对齐方式。
    expect(sidebar).toContain('const panelTop = isWindows ? 0 : measuredPanelTop')
  })

  test('rail 视觉状态直接跟随预览，而不是等待列表卸载', () => {
    expect(sidebar).toContain('const sidebarCollapsed = collapsedOverride ?? s.sidebarCollapsed')
    expect(sidebar).toContain(': { ...s, sidebarCollapsed }')
    expect(sidebar).not.toContain('railOnlyCollapsed')
    expect(shell).toContain('collapsedOverride={leftSidebarDragPreview?.collapsed}')
  })

  test('快捷入口保持挂载以支持双向动画，隐藏时禁止交互', () => {
    expect(rail.match(/className="sidebar-rail-reveal"/g)?.length).toBe(2)
    expect(rail.match(/inert: ''/g)?.length).toBe(2)
    expect(styles).toContain('grid-template-rows: 0fr')
    expect(styles).toContain('grid-template-rows: 1fr')
    expect(styles).toContain('transform: translateY(-12px) scale(0.94)')
    expect(styles).toContain('grid-template-rows 320ms')
  })

  test('rail 使用明确像素端点，过渡不依赖父容器百分比宽度', () => {
    expect(sidebar).toContain('style={{ width: sidebarCollapsed ? COLLAPSED_WIDTH : RAIL_WIDTH }}')
    expect(sidebar).toContain('transition-[width] duration-200 sidebar-collapse-ease motion-reduce:transition-none')
    expect(sidebar).not.toContain("? 'w-full' : 'w-[54px]'")
  })

  test('rail 与顶栏共用唯一着色底面，列表保留独立背景', () => {
    expect(sidebar.match(/before:bg-foreground\/\[0\.035\]/g)).toHaveLength(1)
    expect(sidebar.match(/\bbg-sidebar\b/g)).toHaveLength(2)
    expect(sidebar).toContain('className="relative z-20 h-full overflow-hidden transition-[width]')
  })

  test('顶部窗口拖动层在内容之后、红绿灯之前，且层级高于 rail 和列表', () => {
    const dragStrip = sidebar.indexOf('<SidebarWindowDragStrip height={panelTop}')
    expect(dragStrip).toBeGreaterThan(sidebar.indexOf('<ExpandedSidebar s={s}'))
    expect(dragStrip).toBeLessThan(sidebar.indexOf('<MacTrafficLights classic='))
    expect(sidebar).toContain('panelTop > 0 && <SidebarWindowDragStrip')
    const dragStyles = styles.match(/\.sidebar-window-drag-strip\s*\{([^}]+)\}/)![1]!
    const dragZ = Number(dragStyles.match(/z-index:\s*(\d+)/)![1])
    expect(dragZ).toBeGreaterThan(20)
    expect(dragZ).toBeLessThan(999)
    expect(dragStyles).toContain('-webkit-app-region: drag')
    expect(styles).toContain('.mac-traffic-lights button {\n  -webkit-app-region: no-drag !important;')
  })

  test('列表在固定视口内滑动，收起端点不留可见或可点击区域', () => {
    expect(sidebar).toContain('className="absolute inset-y-0 right-0 z-10 overflow-clip"')
    expect(sidebar).toContain('style={{ left: sidebarCollapsed ? COLLAPSED_WIDTH : RAIL_WIDTH }}')
    expect(sidebar).toContain('left: listTranslateX ?? 0,')
    expect(sidebar).not.toContain('left: RAIL_WIDTH + (listTranslateX ?? 0),')
  })
})
