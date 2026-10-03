import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { ConversationScrollProvider } from './conversation-scroll'

// 验证真实provider的ref/事件/observer接线；受控dispatcher不模拟DOM layout与paint。
function harness() {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const globals = ['window', 'document', 'HTMLElement', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const
  const saved = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const slots: unknown[] = []
  let cursor = 0
  let setupEffect: () => (() => void) | void = () => {}
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0, tick = 0, selecting = false
  class Viewport {
    scrollTop = 80
    scrollHeight = 2000
    clientHeight = 400
    isContentEditable = false
    tagName = 'DIV'
    listeners = new Map<string, Function>()
    addEventListener(name: string, cb: Function) { this.listeners.set(name, cb) }
    removeEventListener(name: string) { this.listeners.delete(name) }
    contains() { return true }
    getBoundingClientRect() { return { top: 0, bottom: 400 } }
    querySelectorAll() { return [] }
  }
  const viewport = new Viewport()
  const documentEvents = new Map<string, Function>()
  const observers: Observer[] = []
  class Observer {
    disconnected = false
    targets: unknown[] = []
    constructor(public callback: () => void) { observers.push(this) }
    observe(target: unknown) { this.targets.push(target) }
    disconnect() { this.disconnected = true }
  }
  Object.assign(globalThis, {
    HTMLElement: Viewport,
    window: { matchMedia: () => ({ matches: false }), getSelection: () => selecting ? {
      isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: viewport }),
    } : null },
    document: { addEventListener(name: string, cb: Function) { documentEvents.set(name, cb) },
      removeEventListener(name: string) { documentEvents.delete(name) } },
    ResizeObserver: Observer,
    requestAnimationFrame(cb: FrameRequestCallback) { frames.set(++nextFrame, cb); return nextFrame },
    cancelAnimationFrame(id: number) { frames.delete(id) },
  })
  const dispatcher = {
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index] as { current: T }
    },
    useState<T>(initial: T): [T, (value: T) => void] {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index] as T, (value) => { slots[index] = value }]
    },
    useLayoutEffect(create: () => (() => void) | void) { setupEffect = create },
  }
  const render = () => {
    cursor = 0
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = dispatcher
    try { return ConversationScrollProvider({ children: null, smoothResize: true }).props.value }
    finally { internals.ReactCurrentDispatcher.current = previous }
  }
  const actions = render()
  actions.scrollRef.current = viewport
  actions.contentRef.current = {}
  let cleanup = setupEffect() as (() => void)
  return {
    viewport, frames, observers, actions, render,
    select() { selecting = true; documentEvents.get('selectionchange')!() },
    replay() { cleanup(); cleanup = setupEffect() as (() => void) },
    drain(count = 60) {
      for (let i = 0; i < count; i++) {
        tick += 16
        const callbacks = [...frames.values()]
        frames.clear()
        callbacks.forEach(callback => callback(tick))
        viewport.listeners.get('scroll')?.()
      }
    },
    dispose() {
      cleanup()
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
    documentEvents,
  }
}

function run(fn: (h: ReturnType<typeof harness>) => void) {
  const h = harness()
  try { fn(h) } finally { h.dispose() }
}

describe('Conversation provider接线', () => {
  test('文本选择与按钮使用同一following状态，随后内容增长仍保持阅读', () => run(h => {
    expect(h.render().following).toBe(true)
    h.select()
    const top = h.viewport.scrollTop
    expect(h.render().following).toBe(false)
    h.viewport.scrollHeight += 120
    h.observers[0]!.callback()
    h.drain()
    expect(h.viewport.scrollTop).toBe(top)
    expect(h.render().following).toBe(false)
  }))

  test('effect重放保留reading模式与位置，且清理旧observer', () => run(h => {
    h.actions.navigate(600, false)
    expect(h.viewport.scrollTop).toBe(600)
    h.replay()
    expect(h.observers[0]!.disconnected).toBe(true)
    expect(h.render().following).toBe(false)
    h.viewport.scrollHeight += 100
    h.observers[1]!.callback()
    h.drain()
    expect(h.viewport.scrollTop).toBe(600)
  }))

  test('导航逐帧执行，resize不会停在第一动画步', () => run(h => {
    h.actions.navigate(600, true)
    h.drain(1)
    expect(h.viewport.scrollTop).toBeGreaterThan(600)
    expect(h.viewport.scrollTop).toBeLessThan(1600)
    h.viewport.scrollHeight += 100
    h.observers[0]!.callback()
    h.drain()
    expect(h.viewport.scrollTop).toBe(600)
  }))

  test('卸载移除所有事件、observer和待执行动画帧', () => {
    const h = harness()
    h.actions.navigate(600, true)
    expect(h.frames.size).toBeGreaterThan(0)
    h.dispose()
    expect(h.frames.size).toBe(0)
    expect(h.viewport.listeners.size).toBe(0)
    expect(h.documentEvents.size).toBe(0)
    expect(h.observers[0]!.disconnected).toBe(true)
  })
})
