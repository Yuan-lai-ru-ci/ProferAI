import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentSkillsToolbar } from './AgentSkillsToolbar'
import type { AgentSkillsToolbarDomain } from './AgentSkillsToolbar'

// 与 QuickTask 的受控 dispatcher harness 一致：运行真实组件与 handler，ref 只替换 DOM focus。
function mountToolbar() {
  interface Internals { ReactCurrentDispatcher: { current: unknown } }
  const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const tabRefs = { current: [] as Array<HTMLButtonElement | null> }
  const changes: AgentSkillsToolbarDomain[] = []
  const focused: number[] = []
  let domain: AgentSkillsToolbarDomain = 'skills'
  let tabs: React.ReactElement<React.ComponentProps<'button'>>[] = []
  const render = () => {
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = { useRef: () => tabRefs }
    let tree: React.ReactElement
    try {
      tree = AgentSkillsToolbar({ scope: 'workspace', domain,
        tabs: [{ value: 'skills', label: 'Skills' }, { value: 'mcp', label: 'MCP' }, { value: 'presets', label: '预设' }],
        search: '', searchPlaceholder: '搜索技能', onSearchChange: () => {},
        onDomainChange: (next) => { changes.push(next); domain = next },
      })
    } finally {
      internals.ReactCurrentDispatcher.current = previous
    }
    tabs = []
    const visit = (node: React.ReactNode): void => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<React.ComponentProps<'button'>>(node)) return
      if (node.props.role === 'tab') tabs.push(node)
      visit(node.props.children)
    }
    visit(tree)
    tabs.forEach((tab, index) => {
      const ref = (tab as unknown as { ref: React.RefCallback<HTMLButtonElement> }).ref
      ref({ focus: () => { focused.push(index) } } as HTMLButtonElement)
    })
  }
  render()
  return { changes, focused,
    selected: () => tabs.map((tab) => ({ selected: tab.props['aria-selected'], tabIndex: tab.props.tabIndex })),
    key: (index: number, key: string) => {
      let prevented = false
      tabs[index]!.props.onKeyDown!({ key, preventDefault: () => { prevented = true } } as React.KeyboardEvent<HTMLButtonElement>)
      render()
      return prevented
    },
  }
}

describe('技能工具栏可访问性', () => {
  test('左右箭头切换并循环，调用受控回调和目标 focus', () => {
    const toolbar = mountToolbar()
    for (const [index, key, target] of [[0, 'ArrowRight', 1], [1, 'ArrowRight', 2], [2, 'ArrowRight', 0], [0, 'ArrowLeft', 2], [2, 'ArrowLeft', 1]] as const) {
      expect(toolbar.key(index, key)).toBe(true)
      expect(toolbar.focused.at(-1)).toBe(target)
      expect(toolbar.selected()).toEqual([0, 1, 2].map((position) => ({ selected: position === target, tabIndex: position === target ? 0 : -1 })))
    }
    expect(toolbar.changes).toEqual(['mcp', 'presets', 'skills', 'presets', 'mcp'])
    expect(toolbar.focused).toEqual([1, 2, 0, 2, 1])
  })

  test('Home/End 跳转首尾，其他按键不阻止默认行为或改动领域和焦点', () => {
    const toolbar = mountToolbar()
    expect(toolbar.key(0, 'End')).toBe(true)
    expect(toolbar.key(2, 'Home')).toBe(true)
    expect(toolbar.changes).toEqual(['presets', 'skills'])
    expect(toolbar.focused).toEqual([2, 0])
    expect(toolbar.key(0, 'Tab')).toBe(false)
    expect(toolbar.key(0, 'ArrowDown')).toBe(false)
    expect(toolbar.changes).toEqual(['presets', 'skills'])
    expect(toolbar.focused).toEqual([2, 0])
  })
  test('搜索有名称，只有活动选项卡进入 Tab 序列', () => {
    const html = renderToStaticMarkup(<AgentSkillsToolbar scope="workspace" domain="skills" tabs={[{ value: 'skills', label: 'Skills' }, { value: 'mcp', label: 'MCP' }]} search="" searchPlaceholder="搜索技能" onDomainChange={() => {}} onSearchChange={() => {}} />)
    expect(html).toContain('aria-label="搜索技能"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('tabindex="-1"')
  })
})
