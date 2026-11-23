import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import type { Channel, ChannelCreateInput, ChannelUpdateInput } from '@profer/shared'
import { channelsAtom } from '../../atoms/chat-atoms'
import { authStatusAtom } from '../../atoms/identity-atoms'
import { agentChannelIdsAtom } from '../../atoms/agent-atoms'
import { coreChannelsAtom, coreTargetsAtom } from '../../atoms/core-target-atoms'

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
  useSetAtom: (target: WritableAtom) => setter(target),
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
function mount(overrides: Record<string, unknown> = {}, remote = false) {
  errors.length = 0
  const localSnapshot = [{ ...fixture, id: 'fixture-local-preserved' }]
  store.set(channelsAtom, localSnapshot)
  store.set(coreChannelsAtom, [])
  store.set(coreTargetsAtom, { currentId: 'local', generation: 0, targets: [{ id: 'local', name: '本机内核', kind: 'local', status: 'disconnected' }] })
  store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'a' })
  store.set(agentChannelIdsAtom, ['fixture-local'])
  if (remote) store.set(coreTargetsAtom, { currentId: 'remote-a', generation: 1, targets: [{ id: 'local', name: '本机内核', kind: 'local', status: 'disconnected' }, { id: 'remote-a', name: 'Remote A', kind: 'remote', status: 'connected' }] })
  let local = [fixture]
  const reads: unknown[] = []
  const updates: ChannelUpdateInput[] = []
  const api = {
    listChannels: async (options: unknown) => { reads.push(options); return local },
    listCoreChannels: async () => [fixture],
    createCoreChannel: async (input: ChannelCreateInput) => ({ ...fixture, ...input, id: 'fixture-remote' }),
    updateCoreChannel: async (_id: string, patch: ChannelUpdateInput) => ({ ...fixture, id: 'fixture-remote', ...patch }),
    deleteCoreChannel: async () => {},
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
    row: () => elements().find((element) => (element.props.channel as Channel | undefined)?.id === fixture.id && typeof element.props.onToggle === 'function')!,
    findText: (text: string) => elements().find((element) => element.props.children === text)!,
  }
}
afterEach(() => {
  mounts.splice(0).forEach((cleanup) => cleanup())
  store.set(coreTargetsAtom, { currentId: 'local', generation: 0, targets: [{ id: 'local', name: '本机内核', kind: 'local', status: 'disconnected' }] })
  Reflect.deleteProperty(globalThis, 'window')
})

describe('ChannelSettings 实际事件回归（fixture IPC）', () => {
  test('Given 自配渠道 When 加载 Then 始终提供编辑与删除入口', async () => {
    const scope = mount()
    await scope.flush()
    const row = scope.row()
    expect(typeof row.props.onEdit).toBe('function')
    expect(typeof row.props.onDelete).toBe('function')
  })
  test('独立本机目录只读，可刷新且不读取桌面渠道', async () => {
    let catalog = [fixture]
    const scope = mount({ listCoreChannels: async () => catalog })
    scope.reads.length = 0
    store.set(coreTargetsAtom, { currentId: 'local', generation: 1, targets: [
      { id: 'local', name: '本机内核', kind: 'local', status: 'connected', independent: true },
    ] })
    scope.render()
    await scope.flush()
    expect(scope.findText('刷新目录')).toBeDefined()
    expect(scope.findText('profer channel add --name NAME --provider PROVIDER --model MODEL_ID')).toBeDefined()
    expect(scope.findText('添加配置')).toBeUndefined()
    expect(scope.row()).toBeUndefined()
    expect(scope.reads).toEqual([])
    catalog = [{ ...fixture, name: 'New Core catalog' }]
    ;(scope.findText('刷新目录').props.onClick as () => void)()
    await scope.flush()
    expect(store.get(coreChannelsAtom)[0]?.name).toBe('New Core catalog')
  })
  test('Given remote Core channel list When settings loads Then only shared remote snapshot changes', async () => {
    const scope = mount({}, true)
    await scope.flush()
    expect(store.get(coreChannelsAtom)).toMatchObject([{ id: 'fixture-local', name: 'Fixture local', apiKey: '' }])
    expect(store.get(channelsAtom)).toEqual([{ ...fixture, id: 'fixture-local-preserved' }])
    expect(scope.reads).toEqual([])
  })
  test('Given remote Core channel delete When confirmed Then remote snapshot refreshes without changing local catalog', async () => {
    const localSnapshot = [{ ...fixture, id: 'fixture-local-preserved' }]
    let remote = [fixture]
    const scope = mount({ listCoreChannels: async () => remote, deleteCoreChannel: async () => { remote = [] } }, true)
    await scope.flush()
    expect(store.get(coreChannelsAtom)).toHaveLength(1)
    const remoteRow = scope.row()
    ;(remoteRow.props.onDelete as () => void)()
    scope.render()
    const confirm = scope.findText('确认删除')
    ;(confirm.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault() {} })
    await scope.flush()
    expect(store.get(coreChannelsAtom)).toEqual([])
    expect(store.get(channelsAtom)).toEqual(localSnapshot)
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
