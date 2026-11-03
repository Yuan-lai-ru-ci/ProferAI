import { expect, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSessionMeta } from '@profer/shared'
import { activeTabIdAtom, tabsAtom, type TabItem } from '@/atoms/tab-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { TabBar } from './TabBar'

/**
 * 回归：草稿是全局固定入口。
 * 曾经 `contextTabs` 按当前会话上下文过滤顶栏 Tab，草稿（sessionId=__scratch-pad__）
 * 被一起过滤掉，Agent 会话激活时顶栏只剩会话 Tab，草稿入口整个消失。
 */

const agentTab = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })
const session = (id: string): AgentSessionMeta =>
  ({ id, title: id, createdAt: 1, updatedAt: 1 }) as AgentSessionMeta

function renderTabBar(tabs: TabItem[], activeTabId: string | null): string {
  const store = createStore()
  store.set(tabsAtom, tabs)
  store.set(activeTabIdAtom, activeTabId)
  store.set(agentSessionsAtom, [session('a1')])
  return renderToStaticMarkup(
    <Provider store={store}>
      <TooltipProvider>
        <TabBar />
      </TooltipProvider>
    </Provider>,
  )
}

test('Agent 会话激活时顶栏仍渲染草稿入口，且排在会话 Tab 之前', () => {
  const html = renderTabBar([agentTab('a1')], 'a1')
  expect(html).toContain('aria-label="草稿"')
  expect(html.indexOf('aria-label="草稿"')).toBeLessThan(html.indexOf('>a1<'))
})

test('草稿在 Tab 列表里缺失时也会补出入口', () => {
  const html = renderTabBar([agentTab('a1')], 'a1')
  expect(html.match(/aria-label="草稿"/g)).toHaveLength(1)
})
