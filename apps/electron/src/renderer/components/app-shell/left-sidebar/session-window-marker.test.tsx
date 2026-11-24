import { expect, test } from 'bun:test'
import * as React from 'react'
import { Provider, createStore } from 'jotai'
import type { ContextMenuItem } from '@profer/ui/primitives/context-menu'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { OtherWindowMenuItems, SessionWindowMarker } from './session-items'

test('窗口标记与置顶/Goal共用无底色线性标记规格及焦点样式', () => {
  const html = renderToStaticMarkup(<TooltipProvider><SessionWindowMarker onSelect={() => {}} /></TooltipProvider>)
  expect(html).toContain('<button')
  expect(html).toContain('type="button"')
  expect(html).toContain('aria-label="前往所在窗口"')
  expect(html).toContain('focus-visible:ring-2')
  expect(html).toContain('size-[13px]')
  expect(html).toContain('width="11"')
  expect(html).toContain('height="11"')
  expect(html).toContain('text-foreground/40')
  expect(html).toContain('hover:text-foreground/75')
  expect(html).not.toContain('bg-')
  expect(html).not.toContain('rounded-md')
})

test('标记只调用一次行导航，菜单才请求移入；两者不互相触发', async () => {
  const previous = globalThis.window
  let selected = 0
  let stopped = 0
  const calls: unknown[] = []
  globalThis.window = { electronAPI: { moveSessionToThisWindow: async (session: unknown) => { calls.push(session); return { ok: true } } } } as unknown as Window & typeof globalThis
  try {
    const tree = SessionWindowMarker({ onSelect: () => { selected++ } })
    const trigger = React.Children.toArray(tree.props.children)[0] as React.ReactElement
    const button = trigger.props.children as React.ReactElement
    const event = { stopPropagation: () => { stopped++ } }
    button.props.onKeyDown(event); button.props.onDoubleClick(event); button.props.onClick(event)
    expect(stopped).toBe(3); expect(selected).toBe(1); expect(calls).toEqual([])
    for (const type of ['agent', 'chat'] as const) {
      const session = { type, sessionId: 'target' }
      const handlers: Array<() => void> = []
      const MenuItem = (({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => {
        handlers.push(onSelect)
        return <button>{children}</button>
      }) as unknown as typeof ContextMenuItem
      const html = renderToStaticMarkup(<Provider store={createStore()}><OtherWindowMenuItems MenuItem={MenuItem} session={session} onGo={() => { selected++ }} /></Provider>)
      expect(html).toContain('前往所在窗口'); expect(html).toContain('移到此窗口')
      const priorMoves = calls.length
      handlers[0]!(); expect(calls).toHaveLength(priorMoves)
      handlers[1]!(); await Promise.resolve()
      expect(calls.at(-1)).toEqual(session)
    }
    expect(selected).toBe(3)
  } finally { globalThis.window = previous }
})
