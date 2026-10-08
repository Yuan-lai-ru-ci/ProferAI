import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import type { Channel } from '@profer/shared'
import type { QuickTaskSubmitInput } from '../../../types/settings'
import type { QuickTaskSettings } from './quick-task-model-eligibility'

mock.module('sonner', () => ({ toast: { error: () => {}, success: () => {} } }))
const { QuickTaskApp } = await import('./QuickTaskApp')
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const fixture: Channel = { id: 'fixture', name: 'Fixture', provider: 'anthropic',
  baseUrl: 'https://fixture.invalid', apiKey: 'fixture-encrypted', enabled: true,
  models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 1, updatedAt: 1 }
const settings: QuickTaskSettings = { agentChannelId: 'fixture', agentModelId: 'model', agentRuntime: 'claude' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const restorers: (() => void)[] = []
function replaceGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  restorers.push(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name) })
}
function mount() {
  const requests: Array<{ settings: ReturnType<typeof deferred<QuickTaskSettings>>; channels: ReturnType<typeof deferred<Channel[]>> }> = []
  const focusListeners = new Set<() => void>()
  const keys = new Set<(event: unknown) => void>()
  const submitted: QuickTaskSubmitInput[] = []
  let storedModel = JSON.stringify({ channelId: 'fixture', modelId: 'model' })
  replaceGlobal('document', { body: { style: {} }, documentElement: { style: {} } })
  replaceGlobal('navigator', { userAgent: 'Mac' })
  replaceGlobal('requestAnimationFrame', () => 1)
  replaceGlobal('localStorage', { getItem: () => storedModel })
  replaceGlobal('window', { electronAPI: {
    getSettings: () => { const request = { settings: deferred<QuickTaskSettings>(), channels: deferred<Channel[]>() }; requests.push(request); return request.settings.promise },
    listChannels: () => requests.at(-1)!.channels.promise,
    onQuickTaskFocus: (listener: () => void) => { focusListeners.add(listener); return () => { focusListeners.delete(listener) } },
    submitQuickTask: async (input: QuickTaskSubmitInput) => { submitted.push(input) },
  }, addEventListener: (_name: string, listener: (event: unknown) => void) => keys.add(listener),
  removeEventListener: (_name: string, listener: (event: unknown) => void) => keys.delete(listener) })
  const slots: Slot[] = []
  let index = 0
  let changed = false
  let unmounted = false
  let writesAfterUnmount = 0
  let effects: (() => void)[] = []
  let tree!: React.ReactElement
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const useMemo = <T,>(factory: () => T, deps: readonly unknown[]): T => {
    const slot = slots[index++] ?? (slots[index - 1] = {})
    if (!same(slot.deps, deps)) { slot.value = factory(); slot.deps = deps }
    return slot.value as T
  }
  const useEffect = (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const slot = slots[index++] ?? (slots[index - 1] = {})
    if (!same(slot.deps, deps)) { slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = fn() || undefined }) }
  }
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const position = index++
      const slot = slots[position] ?? (slots[position] = { value: typeof initial === 'function' ? (initial as () => T)() : initial })
      return [slot.value, (next: T | ((previous: T) => T)) => {
        if (unmounted) { writesAfterUnmount += 1; return }
        const value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next
        if (!Object.is(slot.value, value)) { slot.value = value; changed = true }
      }]
    },
    useRef<T>(value: T) { return useMemo(() => ({ current: value }), []) }, useMemo,
    useCallback<T>(fn: T, deps: readonly unknown[]) { return useMemo(() => fn, deps) }, useEffect,
  }
  const render = () => {
    if (unmounted) return
    let rounds = 0
    do {
      if (++rounds > 30) throw new Error('fixture hook update loop')
      changed = false; index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { tree = QuickTaskApp() } finally { internals.ReactCurrentDispatcher.current = previous }
      const queued = effects; effects = []; queued.forEach((effect) => effect())
    } while (changed)
  }
  const elements = () => {
    const found: React.ReactElement<Record<string, unknown>>[] = []
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      found.push(node); visit(node.props.children)
    }
    visit(tree); return found
  }
  const flush = async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); render() } }
  const unmount = () => { if (unmounted) return; slots.forEach((slot) => slot.cleanup?.()); unmounted = true }
  restorers.push(unmount)
  render()
  return { requests, submitted, flush, unmount, writesAfterUnmount: () => writesAfterUnmount,
    modelInfo: () => slots[4]?.value,
    resolve: (position: number, value = settings, channels = [fixture]) => { requests[position]!.settings.resolve(value); requests[position]!.channels.resolve(channels) },
    switchMode: (mode: string) => { const button = elements().find((element) => element.type === 'button' && element.props.children === mode)!; (button.props.onClick as () => void)(); render() },
    focus: () => { focusListeners.forEach((listener) => listener()); render() },
    listeners: () => focusListeners.size,
    rawSelection: (raw: string) => { storedModel = raw },
    typeText: (value: string) => { const textarea = elements().find((element) => element.type === 'textarea')!; (textarea.props.onChange as (event: unknown) => void)({ target: { value } }); render() },
    submit: async () => { const button = elements().find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children.includes('发送'))!; await (button.props.onClick as () => Promise<void>)(); render() },
  }
}
afterEach(() => { restorers.splice(0).reverse().forEach((restore) => restore()) })

describe('QuickTask 真实组件事件（fixture IPC）', () => {
  test('模式切换后旧成功/失败响应均不覆盖当前模式', async () => {
    const scope = mount()
    scope.switchMode('Chat')
    scope.resolve(1, settings, [{ ...fixture, name: 'Chat Fixture' }]); await scope.flush()
    expect(scope.modelInfo()).toEqual({ channelName: 'Chat Fixture', modelId: 'model' })
    scope.requests[0]!.settings.reject(new Error('fixture stale failure')); await scope.flush()
    expect(scope.modelInfo()).toEqual({ channelName: 'Chat Fixture', modelId: 'model' })
    scope.switchMode('Agent'); scope.switchMode('Chat')
    scope.resolve(3, settings, [{ ...fixture, name: 'Current Chat' }]); await scope.flush()
    scope.resolve(2, settings, [{ ...fixture, name: 'Old Agent' }]); await scope.flush()
    expect(scope.modelInfo()).toEqual({ channelName: 'Current Chat', modelId: 'model' })
  })
  test('focus 使用当前 Chat 绑定且新请求阻止同 mode 的旧响应', async () => {
    const scope = mount(); scope.resolve(0); await scope.flush()
    scope.switchMode('Chat'); scope.resolve(1); await scope.flush()
    scope.focus(); scope.focus()
    expect(scope.listeners()).toBe(1)
    const changedChannels = [{ ...fixture, name: 'Focused Chat' }]
    scope.resolve(3, { ...settings, agentChannelId: 'missing' }, changedChannels); await scope.flush()
    scope.resolve(2, settings, [{ ...fixture, name: 'Stale Focus' }]); await scope.flush()
    expect(scope.modelInfo()).toEqual({ channelName: 'Focused Chat', modelId: 'model' })
  })
  test('卸载取消监听并阻止成功/失败回写', async () => {
    const scope = mount(); scope.focus(); scope.unmount()
    expect(scope.listeners()).toBe(0)
    scope.resolve(1); scope.requests[0]!.settings.reject(new Error('fixture-unmounted')); await scope.flush()
    expect(scope.writesAfterUnmount()).toBe(0)
  })
  test('失效绑定/解析失败只清空展示，不替换；submit 契约仍为 text/mode/files', async () => {
    const scope = mount(); scope.resolve(0, { ...settings, agentRuntime: 'pi' }, [{ ...fixture, agentRuntimes: ['claude'] }]); await scope.flush()
    expect(scope.modelInfo()).toBeNull()
    scope.switchMode('Chat'); scope.rawSelection('{invalid'); scope.resolve(1); await scope.flush()
    expect(scope.modelInfo()).toBeNull()
    scope.typeText('  fixture task  '); await scope.submit()
    expect(scope.submitted).toEqual([{ text: 'fixture task', mode: 'chat', files: [] }])
  })
})
