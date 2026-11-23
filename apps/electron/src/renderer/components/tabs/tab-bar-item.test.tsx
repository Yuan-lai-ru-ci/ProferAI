import { expect, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TabBarItem, type TabBarItemProps } from './TabBarItem'

/**
 * 顶栏标签的防误触与状态表达：
 * - 重命名不再常驻铅笔按钮，避免高频切换标签时误点；
 * - 非激活运行标签用呼吸点表达，激活标签才保留状态环。
 */

const baseProps: TabBarItemProps = {
  id: 'a1',
  type: 'agent',
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

function renderTabItem(overrides: Partial<TabBarItemProps> = {}): string {
  const store = createStore()
  return renderToStaticMarkup(
    <Provider store={store}>
      <TabBarItem {...baseProps} {...overrides} />
    </Provider>,
  )
}

test('有重命名能力时不再渲染常驻铅笔按钮', () => {
  const html = renderTabItem({ onRename: async () => {} })
  expect(html).not.toContain('aria-label="重命名会话"')
  // 标题本身提供双击入口，并保留完整标题提示
  expect(html).toContain('会话 A（双击重命名）')
})

test('没有重命名能力时标题不承诺双击行为', () => {
  const html = renderTabItem()
  expect(html).not.toContain('双击重命名')
  expect(html).not.toContain('aria-label="重命名会话"')
})

test('非激活运行标签渲染呼吸点，而不是整圈状态环', () => {
  const html = renderTabItem({ isStreaming: 'running' })
  expect(html).toContain('title="运行中"')
  expect(html).toContain('topbar-tab-status-running')
})

test('激活运行标签保留状态环，不重复渲染呼吸点', () => {
  const html = renderTabItem({ isActive: true, isStreaming: 'running' })
  expect(html).toContain('topbar-tab-active')
  expect(html).toContain('topbar-tab-status-running')
  expect(html).not.toContain('title="运行中"')
})

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

test('只有标题的连续指针点击重命名，捕获后的按钮 target 仍可命中；单击激活', () => {
  let activated = 0
  const item = mountItem({ onRename: async () => {}, onActivate: () => { activated++ } })
  item.click(true)
  expect(activated).toBe(1)
  expect(item.editing()).toBe(false)
  const previous = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 1
  try { item.click(true, 2) } finally { globalThis.requestAnimationFrame = previous }
  expect(item.editing()).toBe(true)
  expect(activated).toBe(1)
})

test('图标、空白、徽标等非标题点击与快速键盘激活不重命名', () => {
  const item = mountItem({ onRename: async () => {} })
  item.click(false); item.click(false, 2)
  item.click(true); item.click(false, 2)
  item.keyboardClick(); item.keyboardClick()
  expect(item.editing()).toBe(false)
})

test('拖拽、取消指针、松开在标题外不组成双击', () => {
  for (const mode of ['drag', 'cancel', 'outside']) {
    const item = mountItem({ onRename: async () => {} })
    item.click(true, 1, mode === 'drag', mode === 'cancel', mode === 'outside' ? 150 : 50)
    item.click(true)
    expect(item.editing()).toBe(false)
  }
})

test('右键入口保留；Enter 后 blur 不重复保存，失败被消费并可重试', async () => {
  const titles: string[] = []
  let reject!: (error: Error) => void
  const item = mountItem({ onRename: (title) => { titles.push(title); return new Promise<void>((_resolve, no) => { reject = no }) } })
  item.menuRename(); item.change('新标题'); item.key('Enter'); item.blur()
  expect(titles).toEqual(['新标题'])
  reject(new Error('测试失败'))
  await Promise.resolve(); await Promise.resolve(); item.render()
  expect(item.editing()).toBe(true)
  item.key('Enter')
  expect(titles).toEqual(['新标题', '新标题'])
  reject(new Error('重试失败'))
  await Promise.resolve(); await Promise.resolve()
})

test('Escape 取消不保存，blur 保存裁剪后的标题，成功退出编辑', async () => {
  const titles: string[] = []
  const item = mountItem({ onRename: async (title) => { titles.push(title) } })
  item.menuRename(); item.change('取消标题'); item.key('Escape')
  expect(titles).toEqual([])
  expect(item.editing()).toBe(false)
  item.menuRename(); item.change('  新标题  '); item.blur()
  await Promise.resolve(); await Promise.resolve(); item.render()
  expect(titles).toEqual(['新标题'])
  expect(item.editing()).toBe(false)
})

test('标签保持完整圆角，不使用腰部形状；运行点使用共用类', () => {
  expect(renderTabItem()).toContain('rounded-[8px] overflow-hidden')
  expect(renderTabItem()).not.toContain('topbar-tab-shaped')
  expect(renderTabItem({ isStreaming: 'running' })).toContain('topbar-tab-running-dot')
})
