import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import type { Channel, ConversationMeta } from '@profer/shared'
import { channelsAtom, channelsLoadedAtom, conversationsAtom, conversationModelsAtom, conversationModelAtomFamily, selectedModelAtom, channelCatalogRefreshAtom } from '../../atoms/chat-atoms'
import { authStatusAtom } from '../../atoms/identity-atoms'

const store = createStore()
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message) } }))
mock.module('../../lib/model-logo', () => ({ getModelLogo: () => '', getChannelLogo: () => '', DefaultLogo: '' }))
mock.module('../../lib/navigation-controller', () => ({ navigationController: { register: () => () => {} } }))
mock.module('./ChannelPlanQuotaBadge', () => ({ ChannelPlanQuotaBadge: () => null }))
mock.module('../ai-elements/composer/ComposerTool', () => ({ AgentComposerToolTooltip: () => null, getAgentComposerToolTriggerClass: () => '' }))
mock.module('../../hooks/useConversationSettings', () => ({ useConversationModelOptional: () => [store.get(conversationModelAtomFamily('conversation')), (model: { channelId: string; modelId: string }) => store.set(conversationModelsAtom, new Map([['conversation', model]]))] }))
mock.module('../../contexts/session-context', () => ({ useConversationIdOptional: () => 'conversation' }))
const setters = new Map<unknown, (next: unknown) => void>()
const setter = (target: Parameters<typeof store.set>[0]) => {
  let set = setters.get(target)
  if (!set) { set = (next) => store.set(target, next); setters.set(target, set) }
  return set
}
mock.module('jotai', () => ({ atom,
  useAtomValue: (target: Parameters<typeof store.get>[0]) => store.get(target),
  useSetAtom: setter, useStore: () => store,
}))
const { ModelSelector } = await import('./ModelSelector')
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const fixture: Channel = { id: 'fixture', name: 'Fixture', provider: 'openai',
  baseUrl: 'https://fixture.invalid', apiKey: 'encrypted', enabled: true,
  models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 1, updatedAt: 1 }
const meta: ConversationMeta = { id: 'conversation', title: 'Fixture', channelId: 'fixture', modelId: 'model', createdAt: 1, updatedAt: 1 }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const mounts: (() => void)[] = []
function mount(channels = [fixture], conversation = meta) {
  errors.length = 0
  store.set(channelsAtom, channels); store.set(channelsLoadedAtom, true)
  store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'a' })
  store.set(conversationsAtom, [conversation]); store.set(conversationModelsAtom, new Map())
  store.set(selectedModelAtom, { channelId: conversation.channelId!, modelId: conversation.modelId! })
  const requests: ReturnType<typeof deferred<ConversationMeta>>[] = []
  let lists = 0
  const api = {
    listChannels: async () => { lists += 1; return channels },
    updateConversationModel: () => { const request = deferred<ConversationMeta>(); requests.push(request); return request.promise },
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
    useContext: () => false,
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
      try { tree = ModelSelector() } finally { internals.ReactCurrentDispatcher.current = previous }
      const queued = effects; effects = []
      queued.forEach((effect) => effect())
    } while (changed)
  }
  const elements = () => {
    const found: React.ReactElement<Record<string, unknown>>[] = []
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      found.push(node); visit(node.props.children)
    }
    visit(tree)
    return found
  }
  const flush = async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); render() } }
  const cleanup = () => slots.forEach((slot) => slot.cleanup?.())
  mounts.push(cleanup); render()
  return { render, flush, elements, requests, lists: () => lists,
    trigger: () => elements().find((element) => typeof element.props.title === 'string' && typeof element.props.onClick === 'function')!,
    option: () => elements().find((element) => element.type === 'button' && typeof element.props.onMouseEnter === 'function')!,
  }
}
afterEach(() => { mounts.splice(0).forEach((cleanup) => cleanup()); Reflect.deleteProperty(globalThis, 'window') })

describe('ModelSelector 真实交互（fixture IPC）', () => {
  test('打开弹窗请求统一本地目录刷新，组件自身不执行LIST', () => {
    const scope = mount()
    const previous = store.get(channelCatalogRefreshAtom)
    ;(scope.trigger().props.onClick as () => void)(); scope.render()
    expect(store.get(channelCatalogRefreshAtom)).toBe(previous + 1)
    expect(scope.lists()).toBe(0)
  })
  test('连续选择只保存一次，失败保留原会话与默认值并可重试', async () => {
    const scope = mount([fixture, { ...fixture, id: 'second' }], { ...meta, channelId: 'second' })
    const select = scope.option().props.onClick as () => void
    select(); select(); scope.render()
    expect(scope.requests).toHaveLength(1)
    expect(scope.option().props.disabled).toBe(true)
    scope.requests[0]!.reject(new Error('fixture-save-failure')); await scope.flush()
    expect(store.get(conversationsAtom)[0]!.channelId).toBe('second')
    expect(store.get(selectedModelAtom)?.channelId).toBe('second')
    expect(errors).toContain('模型选择保存失败，请重试')
    ;(scope.option().props.onClick as () => void)()
    scope.requests[1]!.resolve(meta); await scope.flush()
    expect(store.get(selectedModelAtom)?.channelId).toBe('fixture')
  })
  test('选择保存期间 A→B→A 后旧回执不覆盖metadata和默认', async () => {
    const scope = mount()
    ;(scope.option().props.onClick as () => void)()
    store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'b' })
    store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'a' })
    const current = { ...meta, channelId: 'fresh' }
    store.set(conversationsAtom, [current])
    scope.requests[0]!.resolve({ ...meta, channelId: 'stale' }); await scope.flush()
    expect(store.get(conversationsAtom)[0]).toEqual(current)
  })
  test('官方同名模型菜单合并，绑定非代表渠道仍显示有效；删除后立即不显示', () => {
    const channels = [{ ...fixture, id: 'newapi-a', serverManaged: true }, { ...fixture, id: 'newapi-b', serverManaged: true }]
    const scope = mount(channels, { ...meta, channelId: 'newapi-b' })
    expect(scope.trigger().props.title).toBe('Model')
    store.set(channelsAtom, [channels[0]!]); scope.render()
    expect(scope.elements().some((element) => element.props.children === '暂无可用模型')).toBe(true)
  })
})
