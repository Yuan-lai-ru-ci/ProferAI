import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { agentPermissionModeMapAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { PermissionModeSelector } from './PermissionModeSelector'

function renderSelector(persistedMode: 'plan' | 'bypassPermissions', cachedMode: 'plan' | 'bypassPermissions'): string {
  const store = createStore()
  store.set(agentSessionsAtom, [{ id: 's', title: 's', createdAt: 1, updatedAt: 1, permissionMode: persistedMode }])
  store.set(agentPermissionModeMapAtom, new Map([['s', cachedMode]]))
  return renderToStaticMarkup(React.createElement(Provider, { store },
    React.createElement(TooltipProvider, null,
      React.createElement(PermissionModeSelector, { sessionId: 's', presetPermissionMode: 'plan', composerTool: true }))))
}

describe('权限图标实际组件渲染', () => {
  test('plan 预设下已确认 bypass 选择不会被 UI 再收紧或旧 map 覆盖', () => {
    const markup = renderSelector('bypassPermissions', 'plan')
    expect(markup).toContain('完全自动')
    expect(markup).not.toContain('预设上限')
  })
  test('换预设后的权威 plan 模式覆盖旧 bypass 缓存', () => {
    const markup = renderSelector('plan', 'bypassPermissions')
    expect(markup).toContain('计划模式')
    expect(markup).not.toContain('完全自动')
  })
})
