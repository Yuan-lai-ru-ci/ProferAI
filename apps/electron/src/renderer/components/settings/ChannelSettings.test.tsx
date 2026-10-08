import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import type { Channel, ChannelUpdateInput } from '@profer/shared'
import { channelsAtom } from '../../atoms/chat-atoms'
import { authStatusAtom } from '../../atoms/identity-atoms'
import { agentChannelIdsAtom } from '../../atoms/agent-atoms'

mock.module('../../lib/model-logo', () => ({ getChannelLogo: () => '' }))
mock.module('./ChannelForm', () => ({ ChannelForm: () => null }))
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (text: string) => errors.push(text) } }))
const store = createStore()
const setters = new Map<unknown, (next: unknown) => void>()
const setter = (target: Parameters<typeof store.set>[0]) => {
  let set = setters.get(target)
  if (!set) { set = (next) => store.set(target, next); setters.set(target, set) }
  return set
}
type ReadableAtom = Parameters<typeof store.get>[0]
type WritableAtom = Parameters<typeof store.set>[0]
mock.module('jotai', () => ({
  atom, useAtom: (target: WritableAtom) => [store.get(target), setter(target)],
  useAtomValue: (target: ReadableAtom) => store.get(target),
}))
const { ChannelSettings } = await import('./ChannelSettings')
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const fixture: Channel = { id: 'fixture-local', name: 'Fixture local', provider: 'openai',
  baseUrl: 'https://fixture.invalid', apiKey: 'encrypted', enabled: true, agentRuntimes: ['pi'],
  models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }], createdAt: 1, updatedAt: 1 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
const mounts: (() => void)[] = []
function mount(overrides: Record<string, unknown> = {}) {
  errors.length = 0
  store.set(channelsAtom, [])
  store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'a' })
  store.set(agentChannelIdsAtom, ['fixture-local'])
  let local = [fixture]
  const reads: unknown[] = []
  const updates: ChannelUpdateInput[] = []
  const api = {
    listChannels: async (options: unknown) => { reads.push(options); return local },
    getAccountCapabilities: async () => ({ commercialMode: false, canSelfConfig: true }),
    getOfficialModelHealth: async () => [], updateSettings: async () => ({}),
    deleteChannel: async () => { local = [] },
    updateChannel: async (_id: string, patch: ChannelUpdateInput) => { updates.push(patch); local = [{ ...fixture, ...patch }]; return local[0] },
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api } })
  const slots: Slot[] = []
  let index = 0
  let changed = false
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
        const value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next
        if (!Object.is(slot.value, value)) { slot.value = value; changed = true }
      }]
    },
    useRef<T>(value: T) { return useMemo(() => ({ current: value }), []) }, useMemo,
    useCallback<T>(fn: T, deps: readonly unknown[]) { return useMemo(() => fn, deps) }, useEffect,
  }
  const render = () => {
    let rounds = 0
    do {
      if (++rounds > 30) throw new Error('fixture hook update loop')
      changed = false; index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { tree = ChannelSettings() } finally { internals.ReactCurrentDispatcher.current = previous }
      const queued = effects; effects = []
      queued.forEach((effect) => effect())
    } while (changed)
  }
  const elements = () => {
    const found: React.ReactElement<Record<string, unknown>>[] = []
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      found.push(node); visit(node.props.children); visit(node.props.action)
    }
    visit(tree)
    return found
  }
  const flush = async () => { for (let i = 0; i < 15; i += 1) { await Promise.resolve(); render() } }
  const cleanup = () => slots.forEach((slot) => slot.cleanup?.())
  mounts.push(cleanup)
  render()
  return { flush, render, elements, reads, updates, cleanup,
    row: () => elements().find((element) => element.props.channel === fixture && typeof element.props.onToggle === 'function')!,
    findText: (text: string) => elements().find((element) => element.props.children === text)!,
  }
}
afterEach(() => { mounts.splice(0).forEach((cleanup) => cleanup()); Reflect.deleteProperty(globalThis, 'window') })

describe('ChannelSettings 实际事件回归（fixture IPC）', () => {
  test('Given 权限读取失败 When 加载 Then 不展示可编辑自配入口，重试后恢复', async () => {
    let attempts = 0
    const scope = mount({ getAccountCapabilities: async () => { if (++attempts === 1) throw new Error('fixture'); return { commercialMode: false, canSelfConfig: true } } })
    await scope.flush()
    const add = scope.elements().find((element) => element.props.onClick && element.props.disabled === true)
    expect(add).toBeDefined()
    expect(scope.row().props.canSelfConfig).toBe(false)
    expect(scope.findText('账号权限读取失败，请重试')).toBeDefined()
    const retry = scope.elements().find((element) => typeof element.props.onClick === 'function' && React.Children.toArray(element.props.children as React.ReactNode).some((child) => React.isValidElement<{ children?: unknown }>(child) && child.props.children === '重试权限'))!
    await (retry.props.onClick as () => Promise<void>)()
    await scope.flush()
    expect(scope.row().props.canSelfConfig).toBe(true)
  })
  test('Given LIST 未返回 When 目录事件已更新 atom Then 迟到 LIST 不覆盖目录', async () => {
    const old = deferred<Channel[]>()
    const scope = mount({ listChannels: () => old.promise })
    const synced = { ...fixture, id: 'synced-model-directory' }
    store.set(channelsAtom, [synced])
    scope.render()
    old.resolve([fixture]); await scope.flush()
    expect(store.get(channelsAtom)).toEqual([synced])
  })
  test('Given 权限读取未返回 When 页面卸载 Then 迟到结果不触发组件状态更新', async () => {
    const pending = deferred<{ commercialMode: boolean; canSelfConfig: boolean }>()
    const scope = mount({ getAccountCapabilities: () => pending.promise })
    scope.cleanup()
    pending.resolve({ commercialMode: false, canSelfConfig: true })
    await scope.flush()
    expect(scope.elements().find((element) => element.props.channel === fixture)?.props.canSelfConfig).not.toBe(true)
  })
  test('Given 删除成功但 settings 失败 When 确认 Then 仍重载目录并关闭确认框', async () => {
    const scope = mount({ updateSettings: async () => { throw new Error('fixture-settings') } })
    await scope.flush()
    ;(scope.row().props.onDelete as () => void)()
    scope.render()
    const confirm = scope.findText('确认删除')
    ;(confirm.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault() {} })
    await scope.flush()
    expect(store.get(channelsAtom)).toEqual([])
    expect(scope.reads).toContainEqual({ localOnly: true })
    expect(errors).toContain('渠道已删除，但默认模型设置保存失败')
    expect(scope.elements().some((element) => element.props.open === false)).toBe(true)
  })
  test('Given 开关请求未完成 When 再点击同渠道 Then 只保存一次并禁用该行', async () => {
    const pending = deferred<Channel>()
    let calls = 0
    const scope = mount({ updateChannel: () => { calls += 1; return pending.promise } })
    await scope.flush()
    const toggle = scope.row().props.onToggle as () => Promise<void>
    const first = toggle()
    await toggle()
    scope.render()
    expect(calls).toBe(1)
    expect(scope.row().props.busy).toBe(true)
    pending.resolve({ ...fixture, enabled: false })
    await first; await scope.flush()
    expect(scope.row().props.busy).toBe(false)
  })
  test('Given A 列表未返回 When 切 B 且 B 已返回 Then A 不覆盖新账号目录', async () => {
    const old = deferred<Channel[]>()
    let calls = 0
    const current = { ...fixture, id: 'fixture-b' }
    const scope = mount({ listChannels: () => ++calls === 1 ? old.promise : Promise.resolve([current]) })
    store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'b' })
    scope.render(); await scope.flush()
    old.resolve([fixture]); await scope.flush()
    expect(store.get(channelsAtom)).toEqual([current])
  })
})
