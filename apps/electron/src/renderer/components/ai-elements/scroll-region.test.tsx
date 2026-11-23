import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { ScrollRegion } from './scroll-region'

// 运行真实 ref/effect 接线；不模拟浏览器布局与绘制。
function mount(forwardedRef: React.ForwardedRef<HTMLDivElement>) {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  let effect: () => (() => void) | void = () => {}
  const dispatcher = {
    useRef<T>(value: T) { return { current: value } },
    useCallback<T>(callback: T) { return callback },
    useLayoutEffect(create: typeof effect) { effect = create },
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const element = {
    dataset: {} as DOMStringMap,
    addEventListener(name: string, callback: (event: unknown) => void) { listeners.set(name, callback) },
    removeEventListener(name: string) { listeners.delete(name) },
    getBoundingClientRect() { return { left: 0, right: 600, top: 0, bottom: 400 } },
  } as unknown as HTMLDivElement
  const render = (ScrollRegion as unknown as {
    render: (props: React.ComponentPropsWithoutRef<'div'>, ref: React.ForwardedRef<HTMLDivElement>) => React.ReactElement
  }).render
  const previous = internals.ReactCurrentDispatcher.current
  internals.ReactCurrentDispatcher.current = dispatcher
  let tree: React.ReactElement
  try { tree = render({ className: 'overflow-y-auto', 'aria-label': '正文' }, forwardedRef) }
  finally { internals.ReactCurrentDispatcher.current = previous }
  const ref = (tree as unknown as { ref: (element: HTMLDivElement | null) => void }).ref
  ref(element)
  const cleanup = effect()
  return {
    element, listeners, tree,
    dispose() { cleanup?.(); ref(null) },
  }
}

describe('ScrollRegion 转发 ref 与显隐接线', () => {
  test('对象 ref 指向同一滚动 DOM，卸载时清空并解绑事件', () => {
    const ref = React.createRef<HTMLDivElement>()
    const h = mount(ref)
    try {
      expect(ref.current).toBe(h.element)
      expect(h.tree.props.className).toBe('profer-scroll-region overflow-y-auto')
      expect(h.tree.props['aria-label']).toBe('正文')
      h.listeners.get('pointermove')?.({ clientX: 595, clientY: 120 })
      expect(h.element.dataset.scrollbarHover).toBe('true')
      h.listeners.get('pointerleave')?.({})
      expect(h.element.dataset.scrollbarHover).toBeUndefined()
      h.listeners.get('scroll')?.({})
      expect(h.element.dataset.scrolling).toBeUndefined()
      h.listeners.get('wheel')?.({ target: null })
      expect(h.element.dataset.scrolling).toBe('true')
      h.listeners.get('scroll')?.({})
      expect(h.element.dataset.scrolling).toBe('true')
    } finally { h.dispose() }
    expect(ref.current).toBeNull()
    expect(h.listeners.size).toBe(0)
    expect(h.element.dataset.scrolling).toBeUndefined()
    expect(h.element.dataset.scrollbarHover).toBeUndefined()
  })

  test('回调 ref 接收挂载与卸载，不改变原生 div 契约', () => {
    const nodes: Array<HTMLDivElement | null> = []
    const h = mount(node => { nodes.push(node) })
    try {
      expect(nodes).toEqual([h.element])
      expect(h.tree.type).toBe('div')
    } finally { h.dispose() }
    expect(nodes).toEqual([h.element, null])
  })
})
