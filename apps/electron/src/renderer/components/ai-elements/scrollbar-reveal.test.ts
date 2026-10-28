import { describe, expect, test } from 'bun:test'
import { attachScrollbarReveal, SCROLLBAR_REVEAL_IDLE_MS } from './scrollbar-reveal'

function setup(options: { watch?: boolean } = {}) {
  const withWatch = options.watch !== false
  const elListeners = new Map<string, (event: unknown) => void>()
  const el = {
    dataset: {} as DOMStringMap,
    addEventListener: (name: string, callback: (event: unknown) => void) => { elListeners.set(name, callback) },
    removeEventListener: (name: string) => { elListeners.delete(name) },
    getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, bottom: 400 }) as DOMRect,
  } as unknown as HTMLElement
  const timers = new Map<number, { callback: () => void; ms: number }>()
  const listeners = new Map<string, (event: unknown) => void>()
  const watch = {
    addEventListener: (name: string, callback: (event: unknown) => void) => { listeners.set(name, callback) },
    removeEventListener: (name: string) => { listeners.delete(name) },
  } as unknown as HTMLElement
  let nextId = 0
  const reveal = attachScrollbarReveal(el, {
    schedule: (callback, ms) => {
      const id = ++nextId
      timers.set(id, { callback, ms })
      return id
    },
    cancel: (id) => { timers.delete(id) },
    /* 传了 watchElement 的调用（进度条）不绑 hover 检测；对话区原生滚动条才绑。 */
    ...(withWatch ? { watchElement: watch } : {}),
  })
  const fire = (id: number): void => {
    const timer = timers.get(id)
    timers.delete(id)
    timer?.callback()
  }
  const emit = (name: string, event: unknown): void => { listeners.get(name)?.(event) }
  const emitEl = (name: string, event: unknown): void => { elListeners.get(name)?.(event) }
  return { el, timers, listeners, elListeners, reveal, fire, emit, emitEl }
}

describe('attachScrollbarReveal', () => {
  test('滚动时露出，空闲后自动隐藏', () => {
    const { el, timers, reveal, fire } = setup()
    expect(reveal.isVisible()).toBe(false)

    reveal.reveal()
    expect(el.dataset.scrolling).toBe('true')
    expect(reveal.isVisible()).toBe(true)
    expect(timers.size).toBe(1)
    expect([...timers.values()][0]?.ms).toBe(SCROLLBAR_REVEAL_IDLE_MS)

    fire(1)
    expect(el.dataset.scrolling).toBeUndefined()
    expect(reveal.isVisible()).toBe(false)
  })

  test('连续滚动只保留最后一个计时器并顺延隐藏', () => {
    const { el, timers, reveal, fire } = setup()
    reveal.reveal()
    reveal.reveal()
    reveal.reveal()
    expect(timers.size).toBe(1)

    fire(3)
    expect(el.dataset.scrolling).toBeUndefined()
  })

  test('dispose 清理计时器并移除标记', () => {
    const { el, timers, reveal } = setup()
    reveal.reveal()
    reveal.dispose()
    expect(timers.size).toBe(0)
    expect(el.dataset.scrolling).toBeUndefined()
  })

  test('监听滚动容器的滚轮/触摸/翻页键，程序性滚动不触发', () => {
    const { el, reveal, emit } = setup()
    expect(reveal.isVisible()).toBe(false)

    emit('wheel', { target: null })
    expect(reveal.isVisible()).toBe(true)

    reveal.dispose()
    expect(reveal.isVisible()).toBe(false)
  })

  test('dispose 会解绑监听', () => {
    const { listeners, reveal } = setup()
    expect(listeners.size).toBeGreaterThan(0)
    reveal.dispose()
    expect(listeners.size).toBe(0)
  })

  test('鼠标进入右侧 12px 热区时露出，离开热区或容器后收回', () => {
    // 不传 watchElement：模拟对话区原生滚动条容器
    const { el, reveal, emitEl } = setup({ watch: false })

    emitEl('pointermove', { clientX: 595, clientY: 120 })
    expect(el.dataset.scrollbarHover).toBe('true')
    // 仅仅是悬停，不能当成“滚动过”（否则会启动 1.25s 隐藏计时）
    expect(reveal.isVisible()).toBe(false)

    emitEl('pointermove', { clientX: 300, clientY: 120 })
    expect(el.dataset.scrollbarHover).toBeUndefined()

    // 纵向出了容器也不算
    emitEl('pointermove', { clientX: 595, clientY: 500 })
    expect(el.dataset.scrollbarHover).toBeUndefined()

    emitEl('pointermove', { clientX: 595, clientY: 120 })
    emitEl('pointerleave', {})
    expect(el.dataset.scrollbarHover).toBeUndefined()
  })
})
