import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLoadedHost } from '../../../../scripts/settings-loaded-visual-host'
import { SettingsNavigation, type SettingsTabGroup } from './SettingsNavigation'
import type { SettingsTab } from '@/atoms/settings-tab'

// 真实组件事件与 SSR 语义验证；未模拟浏览器布局或真实焦点。
const groups: SettingsTabGroup[] = [
  { title: '工作偏好', items: [
    { id: 'general', label: '通用', icon: null, searchTerms: ['开机启动'] },
    { id: 'usage', label: '使用偏好', icon: null, searchTerms: ['归档', '通知'] },
  ] },
  { title: '模型与能力', items: [{ id: 'channels', label: '模型配置', icon: null, searchTerms: ['API Key'] }] },
]

function mount(initialQuery = '') {
  let query = initialQuery
  const changes: SettingsTab[] = []
  const host = createLoadedHost(() => <SettingsNavigation groups={groups} activeTab="general" query={query} onQueryChange={(value) => { query = value }} onTabChange={(tab) => changes.push(tab)} />, new Set(['SettingsNavigation']))
  const render = async () => { await host.settle() }
  const input = () => host.elements().find((node) => node.props.id === 'settings-nav-search')!
  const select = () => host.elements().find((node) => node.props.id === 'settings-mobile-nav')!
  return { host, render, input, select, changes, getQuery: () => query }
}

describe('设置导航的桌面与窄窗口共用行为', () => {
  test('Given 配置名搜索 When 过滤 Then 两种导航显示同一结果且不自动切页', async () => {
    const fixture = mount('API Key')
    try {
      await fixture.render()
      const nodes = fixture.host.elements()
      expect(nodes.filter((node) => node.props['data-settings-tab']).map((node) => node.props['data-settings-tab'])).toEqual(['channels'])
      expect(nodes.filter((node) => node.type === 'option' && node.props.value).map((node) => node.props.value)).toEqual(['channels'])
      expect(fixture.select().props.value).toBe('')
      expect(fixture.changes).toEqual([])
      const choose = fixture.select().props.onChange as (event: unknown) => void
      choose({ target: { value: 'channels' } })
      await fixture.host.click('模型配置')
      expect(fixture.changes).toEqual(['channels', 'channels'])
    } finally { fixture.host.dispose() }
  })

  test('Given 无匹配查询 When 清除 Then 恢复分类与当前选项', async () => {
    const fixture = mount('不存在的配置')
    try {
      await fixture.render()
      expect(fixture.select().props.disabled).toBe(true)
      await fixture.host.click('清除设置搜索')
      expect(fixture.getQuery()).toBe('')
      expect(fixture.select().props.value).toBe('general')
      expect(fixture.host.elements().filter((node) => node.props['data-settings-tab'])).toHaveLength(3)
    } finally { fixture.host.dispose() }
  })

  test('Given 搜索中 When 按 Esc Then 清空且阻止传递关闭设置', async () => {
    const fixture = mount('归档')
    try {
      await fixture.render()
      let prevented = false
      let stopped = false
      const keyDown = fixture.input().props.onKeyDown as (event: unknown) => void
      keyDown({ key: 'Escape', preventDefault: () => { prevented = true }, stopPropagation: () => { stopped = true } })
      await fixture.render()
      expect(fixture.getQuery()).toBe('')
      expect(prevented && stopped).toBe(true)
      prevented = false; stopped = false
      ;(fixture.input().props.onKeyDown as (event: unknown) => void)({ key: 'Escape', preventDefault: () => { prevented = true }, stopPropagation: () => { stopped = true } })
      expect(prevented || stopped).toBe(false)
    } finally { fixture.host.dispose() }
  })

  test('Given 键盘分类导航 When 上下和首尾移动 Then 仅移动焦点而不改设置页', async () => {
    const fixture = mount()
    try {
      await fixture.render()
      const focused: number[] = []
      const buttons = [0, 1, 2].map((index) => ({ focus: () => focused.push(index) }))
      const nav = fixture.host.elements().find((node) => node.type === 'nav')!
      const keyDown = nav.props.onKeyDown as (event: unknown) => void
      for (const key of ['ArrowUp', 'ArrowDown', 'End', 'Home']) {
        keyDown({ key, currentTarget: { querySelectorAll: () => buttons, ownerDocument: { activeElement: buttons[0] } }, preventDefault() {} })
      }
      expect(focused).toEqual([2, 1, 2, 0])
      expect(fixture.changes).toEqual([])
    } finally { fixture.host.dispose() }
  })

  test('Given 响应式布局 When SSR Then 只有一个搜索框且选中/结果数量可被读取', () => {
    const html = renderToStaticMarkup(<SettingsNavigation groups={groups} activeTab="general" query="通用" onQueryChange={() => {}} onTabChange={() => {}} />)
    expect(html.match(/id="settings-nav-search"/g)).toHaveLength(1)
    expect(html).toContain('type="search"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('role="status"')
    expect(html).toContain('找到 1 个设置分类')
  })
})
