import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AutomationPendingTrigger } from '@profer/shared'
import { AutomationPendingTriggers } from './AutomationPendingTriggers'

const records: readonly AutomationPendingTrigger[] = [
  { triggerId: 'queued', scheduledAt: 1, updatedAt: 1, status: 'queued', targetSessionId: 'target' },
  { triggerId: 'blocked', scheduledAt: 2, updatedAt: 2, status: 'blocked', error: '绑定会话已删除', boundSessionId: 'deleted' },
  { triggerId: 'interrupted', scheduledAt: 3, updatedAt: 3, status: 'interrupted', error: '应用重启时运行状态无法恢复' },
  { triggerId: 'running', scheduledAt: 4, updatedAt: 4, status: 'running', runId: 'real-run' },
]

describe('Automation pending trigger presentation', () => {
  test('actual React rendering exposes queued, blocked and interrupted reasons without requiring a bound task', () => {
    const html = renderToStaticMarkup(<AutomationPendingTriggers triggers={records} formatTime={(value) => `时间 ${value}`} onOpenSession={() => {}} />)
    expect(html).toContain('待执行与异常')
    for (const text of ['排队中', '受阻', '已中断', '执行中', '绑定会话已删除', '应用重启时运行状态无法恢复', '时间 1']) expect(html).toContain(text)
    expect(html.match(/查看目标会话/g)).toHaveLength(2)
    expect(html).not.toContain('real-run')
    expect(html).not.toContain('undefined')
  })

  test('target links use the actual execution target first and fall back to the explicit binding', () => {
    const calls: string[] = []
    const tree = AutomationPendingTriggers({ triggers: records, formatTime: String, onOpenSession: (id) => { calls.push(id) } })!
    const list = React.Children.toArray(tree.props.children)[1] as React.ReactElement<{ children: React.ReactNode }>
    for (const row of React.Children.toArray(list.props.children)) {
      const children = (row as React.ReactElement<{ children: React.ReactNode }>).props.children
      const button = React.Children.toArray(children).find((child) => React.isValidElement(child) && child.type === 'button') as React.ReactElement<{ onClick: () => void }> | undefined
      button?.props.onClick()
    }
    expect(calls).toEqual(['target', 'deleted'])
  })

  test('empty projection adds no UI and reason text is escaped by React', () => {
    expect(renderToStaticMarkup(<AutomationPendingTriggers triggers={[]} formatTime={String} onOpenSession={() => {}} />)).toBe('')
    const html = renderToStaticMarkup(<AutomationPendingTriggers triggers={[{ ...records[0]!, error: '<img src=x onerror=alert(1)>' }]} formatTime={String} onOpenSession={() => {}} />)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })
})
