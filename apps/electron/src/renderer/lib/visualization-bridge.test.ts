import { describe, expect, test } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import type { VisualizationContent } from '@profer/shared'
import {
  VISUALIZATION_CSP,
  acceptVisualizationMessage,
  assertSafeVisualizationHtml,
  buildVisualizationSrcDoc,
  cloneVisualizationState,
  isVisualizationBridgeMessage,
  normalizeVisualizationTheme,
  resolveVisualizationQuote,
} from './visualization-bridge'

const content: VisualizationContent = {
  html: '<button data-profer-object-id="node-1">Node</button><img src="data:image/svg+xml,ok">',
  record: {
    schemaVersion: 1,
    id: 'viz-1',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    title: 'Test',
    kind: 'structure',
    revision: 'r1',
    recordVersion: 1,
    summary: 'Test visualization',
    objects: [{ id: 'node-1', label: 'Node', text: 'Node text' }],
    createdAt: 1,
    updatedAt: 1,
  },
}

const identity = { token: 'token-1', revision: 'r1', generation: 'generation-1' }

function message(type: string, extra: Record<string, unknown> = {}) {
  return { ...identity, type, ...extra }
}

describe('visualization bridge', () => {
  test('emits strict CSP and escapes bridge configuration', () => {
    const injection = '</script><script>alert(1)</script>\u2028&'
    const srcDoc = buildVisualizationSrcDoc({ ...content, record: { ...content.record, revision: injection } }, identity)
    expect(srcDoc).toContain(`Content-Security-Policy" content="${VISUALIZATION_CSP}`)
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('<script>'))
    expect(srcDoc).toContain('\\u003c/script\\u003e')
    expect(srcDoc).not.toContain(injection)
    expect(srcDoc).toContain('\\u2028\\u0026')
    expect(srcDoc).toContain("connect-src 'none'")
    expect(srcDoc).not.toContain('allow-same-origin')
  })

  test('rejects navigation primitives and oversized HTML', () => {
    expect(() => assertSafeVisualizationHtml('<base href="https://evil.test">')).toThrow()
    expect(() => assertSafeVisualizationHtml('<meta http-equiv="refresh" content="0;url=https://evil.test">')).toThrow()
    expect(() => assertSafeVisualizationHtml('<meta content="0" HTTP-EQUIV="&#114;efresh">')).toThrow()
    expect(() => assertSafeVisualizationHtml('x'.repeat(512 * 1024 + 1))).toThrow()
  })

  test('enforces a UTF-8 state budget and clones state', () => {
    const input = { nested: { ok: true }, text: '你好' }
    const output = cloneVisualizationState(input)
    expect(output).toEqual(input)
    expect(output).not.toBe(input)
    expect(() => cloneVisualizationState({ value: 'x'.repeat(16 * 1024) })).toThrow()
    expect(() => cloneVisualizationState({ value: '你'.repeat(6000) })).toThrow()
    expect(() => cloneVisualizationState({ value: () => 1 })).toThrow()
    expect(() => cloneVisualizationState({ value: undefined })).toThrow()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => cloneVisualizationState(circular)).toThrow()
  })

  test('accepts only typed messages and rejects oversized or malformed payloads', () => {
    expect(isVisualizationBridgeMessage(message('ready'))).toBe(true)
    expect(isVisualizationBridgeMessage(message('resize', { height: 3200 }))).toBe(true)
    expect(isVisualizationBridgeMessage(message('resize', { height: -1 }))).toBe(false)
    expect(isVisualizationBridgeMessage(message('resize', { height: Infinity }))).toBe(false)
    expect(isVisualizationBridgeMessage(message('resize', { height: 1_000_001 }))).toBe(false)
    expect(isVisualizationBridgeMessage(message('state', { state: { tab: 'one' } }))).toBe(true)
    expect(isVisualizationBridgeMessage(message('state', { state: 'bad' }))).toBe(false)
    expect(isVisualizationBridgeMessage(message('selection', { objectId: 'node-1' }))).toBe(true)
    expect(isVisualizationBridgeMessage(message('selection', { objectId: 'x'.repeat(513) }))).toBe(false)
    expect(isVisualizationBridgeMessage(message('error', { message: 'x'.repeat(1001) }))).toBe(false)
    expect(isVisualizationBridgeMessage(message('wheel', { deltaX: 1, deltaY: Number.NaN }))).toBe(false)
    expect(isVisualizationBridgeMessage({ ...message('state'), state: { value: 'x'.repeat(20 * 1024) } })).toBe(false)
  })

  test('requires iframe source and per-instance identity', () => {
    const iframeWindow = {} as Window
    const accepted = acceptVisualizationMessage({ source: iframeWindow, data: message('ready') }, iframeWindow, identity)
    expect(accepted?.type).toBe('ready')
    expect(acceptVisualizationMessage({ source: {} as Window, data: message('ready') }, iframeWindow, identity)).toBeNull()
    expect(acceptVisualizationMessage({ source: iframeWindow, data: message('ready', { token: 'wrong' }) }, iframeWindow, identity)).toBeNull()
    expect(acceptVisualizationMessage({ source: iframeWindow, data: message('ready', { revision: 'r0' }) }, iframeWindow, identity)).toBeNull()
    expect(acceptVisualizationMessage({ source: iframeWindow, data: message('ready', { generation: 'old' }) }, iframeWindow, identity)).toBeNull()
  })

  test('resolves selected objects only from the record whitelist', () => {
    expect(resolveVisualizationQuote(content, 'node-1')).toEqual({
      visualizationId: 'viz-1', revision: 'r1', objectId: 'node-1', label: 'Node', text: 'Node text',
    })
    expect(resolveVisualizationQuote(content, 'unknown')).toBeNull()
  })

  test('boot runs before generated code and restores bounded state without echo loops', () => {
    const srcDoc = buildVisualizationSrcDoc(content, identity)
    const script = srcDoc.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    expect(srcDoc.indexOf('<script>')).toBeLessThan(srcDoc.indexOf(content.html))
    const windowListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
    const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
    const posted: Array<Record<string, unknown>> = []
    const timers: Array<() => void> = []
    const frames: Array<() => void> = []
    const style = new Map<string, string>()
    const parent = { postMessage: (value: Record<string, unknown>) => posted.push(value) }
    const fakeWindow = {
      parent,
      innerHeight: 500,
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => {
        windowListeners.set(name, [...(windowListeners.get(name) ?? []), handler])
      },
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        for (const handler of windowListeners.get(event.type) ?? []) handler(event as unknown as Record<string, unknown>)
      },
      queueMicrotask: (handler: () => void) => handler(),
      setTimeout: (handler: () => void) => { timers.push(handler); return timers.length },
      requestAnimationFrame: (handler: () => void) => { frames.push(handler); return frames.length },
    }
    const fakeDocument = {
      body: { getBoundingClientRect: () => ({ height: 2400 }), scrollHeight: 2400 },
      querySelectorAll: () => [],
      documentElement: { style: { setProperty: (name: string, value: string) => style.set(name, value) } },
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => {
        documentListeners.set(name, [...(documentListeners.get(name) ?? []), handler])
      },
    }
    const context = createContext({ window: fakeWindow, document: fakeDocument, TextEncoder, ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} }, CustomEvent: class {
      constructor(public type: string, public detailOptions: { detail: unknown }) {}
      get detail() { return this.detailOptions.detail }
    } })
    runInContext(script ?? '', context)
    const api = runInContext('window.proferVisualization', context) as {
      getState: () => Record<string, unknown>
      setState: (state: Record<string, unknown>) => void
      selectObject: (id: string) => void
    }
    expect(posted).toHaveLength(0)
    api.setState(runInContext('({ tab: "default" })', context) as Record<string, unknown>)
    expect(posted.filter((item) => item.type === 'state')).toHaveLength(0)
    for (const handler of documentListeners.get('DOMContentLoaded') ?? []) handler({})
    expect(posted.at(-1)?.type).toBe('ready')
    frames.shift()?.()
    expect(posted.at(-1)).toMatchObject({ type: 'resize', height: 2400 })
    let stateEvents = 0
    windowListeners.set('stateUpdated', [() => { stateEvents++; api.setState(api.getState()) }])
    const sendParent = (data: Record<string, unknown>, source = parent) => {
      for (const handler of windowListeners.get('message') ?? []) handler({ data, source })
    }
    // 在 vm 上下文中生成对象，和浏览器 structured clone 后的同 realm 行为一致。
    const restored = runInContext('({ tab: "comparison", selected: ["node-1"] })', context) as Record<string, unknown>
    sendParent(message('state', { state: restored }))
    expect(api.getState()).toEqual({ tab: 'comparison', selected: ['node-1'] })
    expect(stateEvents).toBe(1)
    expect(posted.filter((item) => item.type === 'state')).toHaveLength(0)
    const clone = api.getState()
    clone.tab = 'mutated'
    expect(api.getState().tab).toBe('comparison')
    sendParent(message('state', { state: runInContext('({ tab: "evil" })', context), token: 'wrong' }))
    expect(api.getState().tab).toBe('comparison')
    api.setState(runInContext('({ tab: "data" })', context) as Record<string, unknown>)
    expect(stateEvents).toBe(2)
    expect(posted.filter((item) => item.type === 'state')).toHaveLength(1)
    api.selectObject('node-1')
    expect(posted.at(-1)?.objectId).toBe('node-1')
    const selected = posted.at(-1)
    expect(selected?.label).toBeUndefined()
    expect(selected?.text).toBeUndefined()
    sendParent(message('theme', { theme: { '--background': '0 0% 7%', '--evil': 'url(https://evil)' } }))
    expect(style.get('--background')).toBe('0 0% 7%')
    expect(style.has('--evil')).toBe(false)
    let blocked = 0
    for (const handler of documentListeners.get('submit') ?? []) handler({ preventDefault: () => blocked++ })
    for (const handler of documentListeners.get('click') ?? []) handler({ target: { closest: (selector: string) => selector === 'a' ? {} : null }, preventDefault: () => blocked++ })
    expect(blocked).toBe(2)
    for (let index = 0; index < 100; index++) {
      for (const handler of documentListeners.get('keydown') ?? []) handler({ isTrusted: true })
    }
    // 选择和连续键盘事件共用节流器，不会逐帧发送 interaction。
    expect(timers).toHaveLength(1)
    timers[0]?.()
    expect(posted.filter((item) => item.type === 'interaction')).toHaveLength(1)
    const beforeWheel = posted.length
    let blockedWheel = 0
    const wheelEvent = { isTrusted: true, deltaX: 2, deltaY: 3, deltaMode: 1, preventDefault: () => { blockedWheel++ } }
    for (let index = 0; index < 20; index++) {
      for (const handler of documentListeners.get('wheel') ?? []) handler(wheelEvent)
    }
    expect(posted).toHaveLength(beforeWheel)
    expect(frames).toHaveLength(1)
    expect(blockedWheel).toBe(20)
    frames.shift()?.()
    const wheelMessages = posted.filter((item) => item.type === 'wheel')
    expect(wheelMessages).toHaveLength(1)
    expect(wheelMessages[0]?.deltaX).toBe(640)
    expect(wheelMessages[0]?.deltaY).toBe(960)
    const beforeError = posted.length
    api.setState(runInContext('({ big: "你".repeat(6000) })', context) as Record<string, unknown>)
    expect(posted).toHaveLength(beforeError + 1)
    expect(posted.at(-1)?.type).toBe('error')
    expect(api.getState().tab).toBe('data')
  })

  test('passes only bounded theme tokens', () => {
    expect(normalizeVisualizationTheme({ '--background': '0 0% 100%', '--evil': 'url(https://evil)' })).toEqual({ '--background': '0 0% 100%' })
  })
})
