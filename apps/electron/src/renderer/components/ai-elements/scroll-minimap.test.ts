import { describe, expect, test } from 'bun:test'
import { getScrollTargetTop, observeMinimapViewport } from './scroll-minimap'

// 真实观察函数 + 可计数几何端口，验证工作量及状态语义，不代表浏览器帧率测量。
function harness() {
  const globals = ['ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const
  const saved = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const frames = new Map<number, FrameRequestCallback>()
  const listeners = new Map<string, () => void>()
  let id = 0
  let scans = 0
  let reads = 0
  let resize = () => {}
  let disconnected = false
  const nodes = [
    { id: 'first', key: 'user:1', top: 0, height: 300 },
    { id: 'second', key: 'assistant:2', top: 300, height: 300 },
    { id: null, key: 'status:3', top: 600, height: 300 },
  ]
  const viewport = {
    scrollTop: 0, scrollHeight: 900, clientHeight: 200,
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback) },
    removeEventListener(name: string) { listeners.delete(name) },
    querySelectorAll() {
      scans++
      return nodes.map(node => ({
        get offsetTop() { reads++; return node.top },
        get offsetHeight() { reads++; return node.height },
        offsetParent: viewport,
        getAttribute(attribute: string) { return attribute === 'data-message-id' ? node.id : node.key },
      }))
    },
  }
  Object.assign(globalThis, {
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() { disconnected = true }
    },
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++id, callback); return id },
    cancelAnimationFrame(frame: number) { frames.delete(frame) },
  })
  type State = Parameters<Parameters<typeof observeMinimapViewport>[2]>[0]
  const states: State[] = []
  const cleanup = observeMinimapViewport(viewport as unknown as HTMLElement, null, state => states.push(state))
  return {
    viewport, nodes, states, frames, listeners,
    scans: () => scans,
    reads: () => reads,
    resize: () => resize(),
    scroll: () => listeners.get('scroll')?.(),
    disconnected: () => disconnected,
    cleanup,
    frame() {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(16))
    },
    dispose() {
      cleanup()
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}
function run(body: (h: ReturnType<typeof harness>) => void) {
  const h = harness()
  try { body(h) } finally { h.dispose() }
}

describe('迷你地图导航定位', () => {
  test('根据滚动视口矩形计算目标位置并居中短消息', () => {
    const target = {
      getBoundingClientRect: () => ({ top: 210 }),
      offsetHeight: 200,
    }
    const container = {
      getBoundingClientRect: () => ({ top: 100 }),
      clientTop: 1,
      scrollTop: 800,
      clientHeight: 600,
    }
    expect(getScrollTargetTop(target as HTMLElement, container as HTMLElement)).toBe(709)
  })

  test('长消息按顶部附近定位且不产生负滚动位置', () => {
    const target = {
      getBoundingClientRect: () => ({ top: 110 }),
      offsetHeight: 900,
    }
    const container = {
      getBoundingClientRect: () => ({ top: 100 }),
      clientTop: 0,
      scrollTop: 0,
      clientHeight: 600,
    }
    expect(getScrollTargetTop(target as HTMLElement, container as HTMLElement)).toBe(0)
  })
})

describe('迷你地图视口更新', () => {
  test('同帧 scroll/resize 合并扫描，双属性节点只测量一次', () => run(h => {
    h.scroll()
    h.resize()
    h.scroll()
    expect(h.frames.size).toBe(1)
    expect(h.scans()).toBe(0)
    h.frame()
    expect(h.scans()).toBe(1)
    expect(h.reads()).toBe(6)
    expect(h.states).toHaveLength(1)
    expect([...h.states[0]!.ids]).toEqual(['first'])
    expect([...h.states[0]!.keys]).toEqual(['user:1'])
  }))

  test('几何和可见项不变不提交状态；单纯滚动复用高亮集合', () => run(h => {
    h.frame()
    h.resize()
    h.scroll()
    h.frame()
    expect(h.states).toHaveLength(1)
    h.viewport.scrollTop = 20
    h.scroll()
    h.frame()
    expect(h.states).toHaveLength(2)
    expect(h.states[1]!.ids).toBe(h.states[0]!.ids)
    expect(h.states[1]!.keys).toBe(h.states[0]!.keys)
    h.viewport.scrollTop = 320
    h.scroll()
    h.frame()
    expect([...h.states[2]!.ids]).toEqual(['second'])
    expect(h.states[2]!.centerId).toBe('second')
    h.viewport.scrollTop = 620
    h.scroll()
    h.frame()
    expect([...h.states[3]!.ids]).toEqual([])
    expect([...h.states[3]!.keys]).toEqual(['status:3'])
  }))

  test('总高度不变但内部重排仍刷新高亮；卸载取消待处理帧', () => run(h => {
    h.frame()
    h.nodes[0]!.top = 400
    h.nodes[1]!.top = 0
    h.resize()
    h.frame()
    expect(h.states).toHaveLength(2)
    expect([...h.states[1]!.ids]).toEqual(['second'])
    h.scroll()
    expect(h.frames.size).toBe(1)
    h.cleanup()
    expect(h.frames.size).toBe(0)
    expect(h.listeners.size).toBe(0)
    expect(h.disconnected()).toBe(true)
  }))
})
