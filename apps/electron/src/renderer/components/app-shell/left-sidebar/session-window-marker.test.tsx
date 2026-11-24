import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { SessionWindowMarker } from './session-items'

test('窗口标记与置顶/Goal共用无底色线性标记规格及焦点样式', () => {
  const html = renderToStaticMarkup(<TooltipProvider><SessionWindowMarker session={{type:'chat',sessionId:'c'}} onSelect={() => {}} /></TooltipProvider>)
  expect(html).toContain('<button')
  expect(html).toContain('type="button"')
  expect(html).toContain('aria-label="聚焦会话窗口"')
  expect(html).toContain('focus-visible:ring-2')
  expect(html).toContain('size-[13px]')
  expect(html).toContain('width="11"')
  expect(html).toContain('height="11"')
  expect(html).toContain('text-foreground/40')
  expect(html).toContain('hover:text-foreground/75')
  expect(html).not.toContain('bg-')
  expect(html).not.toContain('rounded-md')
})

test('Chat/Agent 标记正确聚焦；失败回退且点击/键盘/双击不冒泡', async () => {
  const previous = globalThis.window
  try {
    for (const type of ['chat','agent'] as const) {
      const calls: unknown[] = []
      let fallback = 0
      let stopped = 0
      let focused = true
      globalThis.window = { electronAPI: { focusSessionWindow: async (session: unknown) => { calls.push(session); return focused } } } as unknown as Window & typeof globalThis
      const tree = SessionWindowMarker({session:{type,sessionId:'target'},onSelect:() => { fallback += 1 }})
      const trigger = React.Children.toArray(tree.props.children)[0] as React.ReactElement
      const button = trigger.props.children as React.ReactElement
      const event = {stopPropagation:() => { stopped += 1 }}
      button.props.onKeyDown(event)
      button.props.onDoubleClick(event)
      button.props.onClick(event)
      await Promise.resolve(); await Promise.resolve()
      expect(calls).toEqual([{type,sessionId:'target'}])
      expect(fallback).toBe(0)
      focused = false
      button.props.onClick(event)
      await Promise.resolve(); await Promise.resolve()
      expect(fallback).toBe(1)
      expect(stopped).toBe(4)
    }
  } finally { globalThis.window = previous }
})
