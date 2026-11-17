import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const sidebar = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8')
const rail = readFileSync(new URL('./left-sidebar/rail.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../styles/globals.css', import.meta.url), 'utf8')

describe('侧栏 rail 吸附预览接线', () => {
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
})
