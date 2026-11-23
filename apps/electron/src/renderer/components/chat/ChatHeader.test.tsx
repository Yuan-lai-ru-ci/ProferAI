import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationMeta } from '@profer/shared'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { ConversationProvider } from '@/contexts/session-context'
import { chatTopBarHostAtom } from '@/atoms/chat-topbar-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { ChatHeader } from './ChatHeader'
import { TabBarItem, type TabBarItemProps } from '../tabs/TabBarItem'
import { TabBar } from '../tabs/TabBar'

// 服务端渲染只检查 Portal 内容和归属；真实 DOM 挂载由可见预览检查。
mock.module('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
const conversation: ConversationMeta = { id: 'chat-a', title: '唯一会话标题', channelId: 'c', modelId: 'm', createdAt: 1, updatedAt: 1 }

function renderHeader(hostId: string | null, standalone = false, meta: ConversationMeta | null = conversation): string {
  const store = createStore()
  if (hostId) store.set(chatTopBarHostAtom, { conversationId: hostId, element: {} as HTMLElement })
  return renderToStaticMarkup(<Provider store={store}><TooltipProvider><ConversationProvider conversationId={conversation.id}>
    <ChatHeader conversation={meta} standalone={standalone} onOpenHistory={() => {}} />
  </ConversationProvider></TooltipProvider></Provider>)
}

describe('Chat 操作归入顶栏', () => {
  test('主窗口不再输出重复标题或 48px 标题行', () => {
    const html = renderHeader('chat-a')
    expect(html).not.toContain(conversation.title)
    expect(html).not.toContain('48px')
    for (const label of ['对话节点树', '置顶对话', '并排模式']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('aria-label="提示词:')
  })
  test('只有匹配会话向顶栏输出操作；无插槽、非焦点和空 metadata 都安全', () => {
    expect(renderHeader(null)).toBe('')
    expect(renderHeader('chat-b')).toBe('')
    expect(renderHeader('chat-a', false, null)).toBe('')
  })
  test('独立窗口保留标题、重命名和操作', () => {
    const html = renderHeader(null, true)
    expect(html).toContain(conversation.title)
    expect(html).toContain('aria-label="编辑标题"')
    expect(html).toContain('aria-label="对话节点树"')
  })
  test('Chat Tab 提供重命名入口和带会话归属的操作插槽', () => {
    const store = createStore()
    store.set(tabsAtom, [{ id: 'chat-a', sessionId: 'chat-a', type: 'chat', title: conversation.title }])
    store.set(activeTabIdAtom, 'chat-a')
    const html = renderToStaticMarkup(<Provider store={store}><TooltipProvider><TabBar /></TooltipProvider></Provider>)
    expect(html).toContain(`${conversation.title}（双击重命名）`)
    expect(html).not.toContain('aria-label="重命名会话"')
    expect(html).toContain('data-conversation-id="chat-a"')
  })
})

const baseProps: TabBarItemProps = {
  id: 'a1',
  type: 'chat',
  title: '会话 A',
  isActive: false,
  isStreaming: 'idle',
  isHovered: false,
  isLeaving: false,
  onActivate: () => {},
  onClose: () => {},
  onMiddleClick: () => {},
  onDragStart: () => {},
  onHoverEnter: () => {},
  onHoverLeave: () => {},
  onPanelHoverEnter: () => {},
  onPanelHoverLeave: () => {},
}

// 沿用仓库的受控 dispatcher：执行真实 handler，不模拟 DOM 事件分发。
function mountItem(overrides: Partial<TabBarItemProps> = {}) {
  interface Internals { ReactCurrentDispatcher: { current: unknown } }
  const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const store = createStore()
  const slots: unknown[] = []
  let index = 0
  let tree: React.ReactElement
  let elements: React.ReactElement<Record<string, unknown>>[] = []
  const useState = <T,>(initial: T | (() => T)) => {
    const position = index++
    if (!(position in slots)) slots[position] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [slots[position], (next: T | ((previous: T) => T)) => {
      slots[position] = typeof next === 'function' ? (next as (previous: T) => T)(slots[position] as T) : next
    }]
  }
  const dispatcher = {
    useState,
    useRef<T>(initial: T) { return useState(() => ({ current: initial }))[0] },
    useReducer<T>(reducer: (state: T) => T, initial: T, init?: (value: T) => T) {
      const [value, set] = useState(() => init ? init(initial) : initial)
      return [value, () => (set as (fn: (state: T) => T) => void)(reducer)]
    },
    useContext: () => store,
    useEffect: () => {}, useDebugValue: () => {},
    useCallback: <T,>(fn: T) => fn,
  }
  const titleNode = { contains: (target: unknown) => target === titleNode,
    getBoundingClientRect: () => ({ left: 20, right: 120, top: 0, bottom: 37 }) }
  const buttonNode = { setPointerCapture: () => {}, hasPointerCapture: () => true, releasePointerCapture: () => {} }
  const render = () => {
    index = 0
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = dispatcher
    try { tree = TabBarItem({ ...baseProps, ...overrides }) } finally { internals.ReactCurrentDispatcher.current = previous }
    elements = []
    const visit = (node: React.ReactNode): void => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      elements.push(node)
      const ref = (node as unknown as { ref?: { current: unknown } }).ref
      if (ref && typeof ref === 'object' && node.props.title === '会话 A（双击重命名）') ref.current = titleNode
      visit(node.props.children as React.ReactNode)
    }
    visit(tree!)
  }
  const find = (predicate: (node: React.ReactElement<Record<string, unknown>>) => boolean) => {
    const node = elements.find(predicate)
    if (!node) throw new Error('找不到测试元素')
    return node
  }
  const call = (node: React.ReactElement<Record<string, unknown>>, name: string, data: Record<string, unknown> = {}) => {
    (node.props[name] as (event: unknown) => void)({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, ...data })
  }
  const tab = () => find((node) => node.props.role === 'tab')
  render()
  return { render,
    editing: () => elements.some((node) => node.type === 'input'),
    click: (title: boolean, detail = 1, drag = false, cancel = false, releaseX = title ? 50 : 150) => {
      call(tab(), 'onPointerDown', { button: 0, target: title ? titleNode : buttonNode, currentTarget: buttonNode, clientX: title ? 50 : 150, clientY: 15, pointerId: 1 })
      if (drag) call(tab(), 'onPointerMove', { clientX: 90, clientY: 15 })
      call(tab(), cancel ? 'onPointerCancel' : 'onPointerUp', { currentTarget: buttonNode, pointerId: 1, type: cancel ? 'pointercancel' : 'pointerup' })
      call(tab(), 'onClick', { detail, clientX: releaseX, clientY: 15, target: buttonNode })
      render()
    },
    keyboardClick: () => { call(tab(), 'onClick', { detail: 0 }); render() },
    menuRename: () => {
      const previous = globalThis.requestAnimationFrame
      globalThis.requestAnimationFrame = () => 1
      try { call(find((node) => node.props.onSelect !== undefined && React.Children.toArray(node.props.children as React.ReactNode).includes('重命名')), 'onSelect') } finally { globalThis.requestAnimationFrame = previous }
      render()
    },
    change: (value: string) => { call(find((node) => node.type === 'input'), 'onChange', { target: { value } }); render() },
    key: (key: string) => { call(find((node) => node.type === 'input'), 'onKeyDown', { key }); render() },
    blur: () => { call(find((node) => node.type === 'input'), 'onBlur'); render() },
  }
}


test('Chat 标签双击和右键均执行真实编辑 handler，并向重命名回调提交裁剪后的标题', async () => {
  for (const entry of ['double-click', 'context-menu']) {
    const saved: string[] = []
    const item = mountItem({ onRename: async (title) => { saved.push(title) } })
    if (entry === 'context-menu') item.menuRename()
    else {
      item.click(true)
      const previous = globalThis.requestAnimationFrame
      globalThis.requestAnimationFrame = () => 1
      try { item.click(true, 2) } finally { globalThis.requestAnimationFrame = previous }
    }
    expect(item.editing()).toBe(true)
    item.change('  Chat 新标题  ')
    item.key('Enter')
    item.blur()
    await Promise.resolve(); await Promise.resolve(); item.render()
    expect(saved).toEqual(['Chat 新标题'])
    expect(item.editing()).toBe(false)
  }
})
