import { describe, expect, test } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import type { VisualizationContent } from '@profer/shared'
import { buildVisualizationSrcDoc } from './visualization-bridge'

/**
 * 高度上报策略的回归测试。
 *
 * ⚠️ 说明：本文件是一次**重写**。原来的同名文件是未纳入版本控制的 WIP，且没有备份，
 * 在一次「改造成固定视口模型」的尝试里被覆盖后无法原样恢复。这里按它留下的契约说明
 * 与 5 条用例名重建等价覆盖；如果原作者保留着编辑器本地历史，可以拿原版替换。
 *
 * 契约（改这里之前先想清楚）：
 * - 首次、以及 ≥240px（LAYOUT_IMPATIENT_DELTA）的结构性跳变：立即上报；
 * - 变高 ≥24px（LAYOUT_GROW_STEP）：跟一步，但至少间隔一个安静窗口
 *   （LAYOUT_QUIET_MS = 150ms，约 6 次/秒），不裁掉正在生长的内容；
 * - 变矮、抖动：等布局安静 150ms 后再按最终高度收口一次。
 */

const content: VisualizationContent = {
  html: '<p>hi</p>',
  record: {
    schemaVersion: 1, id: 'viz-layout', sessionId: 'session-1', toolCallId: 'tool-1',
    title: 'Layout', kind: 'structure', revision: 'r1', recordVersion: 1,
    summary: 'layout probe', objects: [], createdAt: 1, updatedAt: 1,
  },
}
const identity = { token: 'token-layout', revision: 'r1', generation: 'generation-layout' }

class FakeElement {
  nodeType = 1
  attributes = new Set<string>()
  styleWrites: string[] = []
  overflow = 'visible'
  parent: FakeElement | null = null
  closest(selector: string): FakeElement | null {
    if (selector.includes('data-profer-scroll') && this.attributes.has('data-profer-scroll')) return this
    return this.parent?.closest(selector) ?? null
  }
  getBoundingClientRect(): { height: number } { return { height: 0 } }
  setAttribute(name: string): void { this.attributes.add(name) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  get style(): { setProperty: (name: string, value: string) => void } {
    return { setProperty: (name, value) => { this.styleWrites.push(`${name}:${value}`) } }
  }
}

function createHarness(initialHeight = 1000) {
  const posted: Array<Record<string, unknown>> = []
  const frames: Array<() => void> = []
  const timers = new Map<number, { at: number; handler: () => void }>()
  const documentListeners = new Map<string, Array<(event: unknown) => void>>()
  const windowListeners = new Map<string, Array<(event: unknown) => void>>()
  const mutationHandlers: Array<(records: Array<Record<string, unknown>>) => void> = []
  const resizeHandlers: Array<() => void> = []
  const elements: FakeElement[] = []
  let nextTimerId = 1
  let now = 0
  let height = initialHeight
  let fontReady: (() => void) | null = null

  const body = new FakeElement()
  const document = {
    body,
    documentElement: body,
    fonts: { get ready() { return { then: (cb: () => void) => { fontReady = cb } } } },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), handler])
    },
    querySelectorAll: (selector: string) =>
      /^body \*/.test(selector)
        ? elements.filter((element) => !/data-profer-layout-checked/.test(selector) || !element.hasAttribute('data-profer-layout-checked'))
        : [],
    createElement: () => ({ ...new FakeElement(), appendChild: () => {}, remove: () => {} }),
  }
  const windowObject: Record<string, unknown> = {
    document,
    parent: { postMessage: (message: Record<string, unknown>) => { posted.push(message) } },
    crypto: { randomUUID: () => 'uuid' },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), handler])
    },
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
    setTimeout: (handler: () => void, delay = 0) => { const id = nextTimerId++; timers.set(id, { at: now + delay, handler }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    getComputedStyle: (element: FakeElement) => ({ overflowY: element.overflow }),
    performance: { now: () => now },
  }
  windowObject.window = windowObject
  const context = createContext({
    window: windowObject,
    document,
    HTMLElement: FakeElement,
    Node: FakeElement,
    ResizeObserver: class { constructor(callback: () => void) { resizeHandlers.push(callback) } observe() {} },
    MutationObserver: class {
      constructor(callback: (records: Array<Record<string, unknown>>) => void) { mutationHandlers.push(callback) }
      observe() {}
    },
    performance: { now: () => now },
    requestAnimationFrame: windowObject.requestAnimationFrame,
    TextEncoder,
    JSON, Math, Number, Object, Array, String, RegExp, Date, Error, Boolean, isFinite,
  })
  runInContext(buildVisualizationSrcDoc(content, identity).match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '', context)

  const boot = () => { for (const handler of documentListeners.get('DOMContentLoaded') ?? []) handler({}) }
  const drainFrames = (count = 1) => { for (let index = 0; index < count; index++) frames.shift()?.() }
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.handler() }
  }
  const fireResize = () => { for (const handler of resizeHandlers) handler() }
  const resizes = () => posted.filter((item) => item.type === 'resize')
  return {
    posted, elements, body,
    setHeight: (next: number) => { height = next },
    measure: () => height,
    boot, drainFrames, advance, fireResize, resizes,
    fontReady: () => fontReady?.(),
    fireMutations: (records: Array<Record<string, unknown>>) => { for (const handler of mutationHandlers) handler(records) },
  }
}

// getBoundingClientRect / scrollHeight 由 harness 的高度变量统一决定
function patchMeasure(harness: ReturnType<typeof createHarness>): void {
  Object.defineProperty(harness.body, 'getBoundingClientRect', { value: () => ({ height: harness.measure() }) })
  Object.defineProperty(harness.body, 'scrollHeight', { get: () => harness.measure() })
}

function booted(initialHeight: number) {
  const harness = createHarness(initialHeight)
  patchMeasure(harness)
  harness.boot()
  harness.drainFrames()
  return harness
}

describe('visualization bridge layout reporting', () => {
  test('静态内容只在首次上报一次', () => {
    const harness = booted(1000)
    expect(harness.resizes()).toHaveLength(1)
    expect(harness.resizes()[0]).toMatchObject({ height: 1000 })
    for (let index = 0; index < 5; index++) {
      harness.fireResize()
      harness.drainFrames()
      harness.advance(200)
    }
    expect(harness.resizes()).toHaveLength(1)
  })

  test('按帧抖动的内容不逐帧改宿主布局，停稳后按最终高度收口一次', () => {
    const harness = booted(1000)
    const before = harness.resizes().length
    for (let index = 0; index < 8; index++) {
      harness.setHeight(1000 + (index % 2 === 0 ? 5 : -5))
      harness.fireResize()
      harness.drainFrames()
      harness.advance(16)
    }
    expect(harness.resizes().length).toBe(before)
    harness.setHeight(1004)
    // 安静窗口是 LAYOUT_QUIET_MS = 150ms：推进要越过它，收口才会发生。
    harness.advance(200)
    expect(harness.resizes().length).toBe(before + 1)
    expect(harness.resizes().at(-1)).toMatchObject({ height: 1004 })
  })

  test('结构性跳变（≥240px）立即上报，不等安静窗口', () => {
    const harness = booted(1000)
    const before = harness.resizes().length
    harness.setHeight(1300)
    harness.fireResize()
    harness.drainFrames()
    expect(harness.resizes().length).toBe(before + 1)
    expect(harness.resizes().at(-1)).toMatchObject({ height: 1300 })
  })

  test('持续生长的内容跟得上，但受安静窗口限速', () => {
    const harness = booted(1000)
    const before = harness.resizes().length
    for (let index = 0; index < 40; index++) {
      harness.setHeight(1000 + (index + 1) * 20)
      harness.fireResize()
      harness.drainFrames()
      harness.advance(16)
    }
    const grown = harness.resizes().length - before
    expect(grown).toBeGreaterThan(1) // 跟得上
    expect(grown).toBeLessThan(40) // 不是逐帧推
  })

  test('归一化只扫未检查过的元素，坏元素变化后才重查一次', () => {
    const scroller = new FakeElement()
    scroller.overflow = 'auto'
    const harness = createHarness(1000)
    harness.elements.push(scroller)
    patchMeasure(harness)
    harness.boot()
    harness.drainFrames()
    expect(scroller.styleWrites).toHaveLength(3)
    harness.fireResize()
    harness.drainFrames()
    expect(scroller.styleWrites).toHaveLength(3) // 已打过标记，不再重查
    harness.fireMutations([{ type: 'attributes', attributeName: 'class', target: scroller }])
    harness.drainFrames()
    expect(scroller.styleWrites).toHaveLength(6) // 变化过的元素重查一次
  })
})
