import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import type { Channel, ChatSendInput, ConversationMeta } from '@profer/shared'
import { channelsAtom, channelsLoadedAtom, conversationsAtom, conversationModelAtomFamily, conversationModelsAtom } from '../../atoms/chat-atoms'
import { authStatusAtom } from '../../atoms/identity-atoms'

const store = createStore()
const errors: string[] = []
mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message) } }))
mock.module('./ChatHeader', () => ({ ChatHeader: () => null }))
mock.module('./ChatMessages', () => ({ ChatMessages: () => null }))
mock.module('./ChatInput', () => ({ ChatInput: () => null }))
mock.module('./HistoryDrawer', () => ({ BranchTreeView: () => null }))
mock.module('./AgentRecommendBanner', () => ({ AgentRecommendBanner: () => null }))
mock.module('./PromptEditorSidebar', () => ({ PromptEditorSidebar: () => null }))
mock.module('../knowledge-base/KnowledgePreviewPanel', () => ({ KNOWLEDGE_PREVIEW_EVENT: 'fixture-preview', KnowledgePreviewContent: () => null }))
mock.module('../../hooks/useGlobalChatListeners', () => ({ registerPendingTitle: () => {} }))
mock.module('../../hooks/useConversationSettings', () => ({
  useConversationModel: () => [store.get(conversationModelAtomFamily('conversation')), () => {}],
  useConversationContextLength: () => ['infinite'], useConversationThinkingEnabled: () => [false],
  useConversationPromptId: () => [''],
}))
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
const { ChatView } = await import('./ChatView')
interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
interface Internals { ReactCurrentDispatcher: { current: unknown } }
const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: Internals }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const fixture: Channel = { id: 'fixture', name: 'Fixture', provider: 'openai',
  baseUrl: 'https://fixture.invalid', apiKey: 'encrypted', enabled: true,
  models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 1, updatedAt: 1 }
const meta: ConversationMeta = { id: 'conversation', title: 'Fixture', channelId: 'fixture', modelId: 'model', createdAt: 1, updatedAt: 1 }
const mounts: (() => void)[] = []
function mount() {
  errors.length = 0
  store.set(channelsAtom, [fixture]); store.set(channelsLoadedAtom, true)
  store.set(authStatusAtom, { isLoggedIn: true })
  store.set(conversationsAtom, [meta]); store.set(conversationModelsAtom, new Map())
  const sends: ChatSendInput[] = []
  let forks = 0
  const api = {
    getBranch: async () => [], sendMessage: async (input: ChatSendInput) => { sends.push(input) },
    forkBranchAt: async () => { forks += 1; return { id: 'forked' } },
    updateConversationModel: async () => { throw new Error('必须保留metadata，不允许失效时改写') },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api,
    addEventListener() {}, removeEventListener() {} } })
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
      try {
        const view = ChatView({ conversationId: 'conversation' })
        const inner = view.props.children as React.ReactElement<{ conversationId: string }>
        tree = (inner.type as (props: { conversationId: string }) => React.ReactElement)(inner.props)
      } finally { internals.ReactCurrentDispatcher.current = previous }
      const queued = effects; effects = []
      queued.forEach((effect) => effect())
    } while (changed)
  }
  const find = (key: string) => {
    const found: React.ReactElement<Record<string, unknown>>[] = []
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      found.push(node); visit(node.props.children)
    }
    visit(tree)
    return found.find((element) => typeof element.props[key] === 'function')!.props[key]
  }
  const flush = async () => { for (let i = 0; i < 8; i += 1) { await Promise.resolve(); render() } }
  const cleanup = () => slots.forEach((slot) => slot.cleanup?.())
  mounts.push(cleanup); render()
  return { render, flush, find, sends, forks: () => forks }
}
afterEach(() => { mounts.splice(0).forEach((cleanup) => cleanup()); Reflect.deleteProperty(globalThis, 'window') })

describe('ChatView真实事件：失效模型不得发送/重发（fixture IPC）', () => {
  test('Given 回调持有旧模型 When 目录停用 Then 发送读最新store、零send、保留metadata', async () => {
    const scope = mount(); await scope.flush()
    const send = scope.find('onSend') as (content: string) => Promise<void>
    const before = store.get(conversationsAtom)
    store.set(channelsAtom, [{ ...fixture, models: [{ ...fixture.models[0]!, enabled: false }] }])
    await send('fixture content')
    expect(scope.sends).toEqual([])
    expect(store.get(conversationsAtom)).toBe(before)
    expect(errors).toContain('当前模型不可用，请重新选择已启用的 Chat 模型')
  })
  test('Given 历史模型已删除 When 重发/编辑重发 Then 零fork、零send、不改历史绑定', async () => {
    const scope = mount(); await scope.flush()
    store.set(channelsAtom, [])
    const resend = scope.find('onResendMessage') as (message: { id: string; content: string }) => Promise<void>
    const edit = scope.find('onSubmitInlineEdit') as (message: { id: string; content: string }, payload: { content: string }) => Promise<void>
    await resend({ id: 'message', content: 'fixture content' })
    await edit({ id: 'message', content: 'fixture content' }, { content: 'edited' })
    expect(scope.forks()).toBe(0)
    expect(scope.sends).toEqual([])
    expect(store.get(conversationsAtom)[0]).toEqual(meta)
  })
  test('Given 当前有效绑定 When 发送 Then 仅使用当前会话真实模型一次', async () => {
    const scope = mount(); await scope.flush()
    await (scope.find('onSend') as (content: string) => Promise<void>)('fixture content')
    expect(scope.sends).toHaveLength(1)
    expect(scope.sends[0]).toMatchObject({ conversationId: 'conversation', channelId: 'fixture', modelId: 'model', userMessage: 'fixture content' })
  })
})
