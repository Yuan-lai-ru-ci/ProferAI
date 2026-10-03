import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { conversationFollowIntentAtomFamily, requestConversationFollowAtom } from '../../atoms/conversation-scroll-intents'
import { ConversationFollowTrigger } from './conversation-follow-trigger'

// 受控 render/commit 直接执行生产组件及 Jotai 订阅，不模拟 DOM layout/paint。
function harness(sessionId: string, initialIntent?: number) {
  const store = createStore()
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previousDispatcher = internals.ReactCurrentDispatcher.current
  internals.ReactCurrentDispatcher.current = { useRef: () => ({ current: null }) }
  let provider: ReturnType<typeof Provider>
  try { provider = Provider({ store, children: null }) }
  finally { internals.ReactCurrentDispatcher.current = previousDispatcher }
  const storeContext = (provider.type as unknown as { _context: React.Context<unknown> })._context
  const slots: unknown[] = []
  const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void; create: () => void | (() => void) }> = []
  let cursor = 0
  let jobs: Array<() => void> = []
  let follows = 0
  const actions = { follow: () => { follows++ } }
  const dispatcher = {
    useContext(context: React.Context<unknown>) { return context === storeContext ? store : actions },
    useRef<T>(value: T): { current: T } {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: value }
      return slots[index] as { current: T }
    },
    useReducer<S>(reducer: (state: S) => S, _initial: unknown, initialize: () => S): [S, () => void] {
      const index = cursor++
      if (!(index in slots)) slots[index] = initialize()
      return [slots[index] as S, () => { slots[index] = reducer(slots[index] as S) }]
    },
    useDebugValue() {},
    useEffect(create: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++
      const previous = effects[index]
      if (previous && deps && previous.deps && deps.every((value, i) => Object.is(value, previous.deps![i]))) return
      jobs.push(() => {
        previous?.cleanup?.()
        effects[index] = { deps, create, cleanup: create() || undefined }
      })
    },
  }
  return {
    store,
    render({ loaded = true, active = true } = {}) {
      cursor = 0
      jobs = []
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { ConversationFollowTrigger({ sessionId, loaded, active, initialIntent }) }
      finally { internals.ReactCurrentDispatcher.current = previous }
      jobs.forEach(job => job())
    },
    send() { store.set(requestConversationFollowAtom, sessionId) },
    count: () => follows,
    replay() { effects.forEach(effect => { effect?.cleanup?.(); if (effect) effect.cleanup = effect.create() || undefined }) },
    dispose() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}

function run(sessionId: string, testBody: (h: ReturnType<typeof harness>) => void, initialIntent?: number) {
  const h = harness(sessionId, initialIntent)
  try { testBody(h) } finally { h.dispose() }
}

describe('ConversationFollowTrigger 生产订阅接线', () => {
  test('首次挂载和 effect 重放不 follow；一次新发送仅 follow 一次', () => run('chat', h => {
    h.store.set(conversationFollowIntentAtomFamily('chat'), 5)
    h.render()
    h.replay()
    expect(h.count()).toBe(0)
    h.send()
    h.render()
    h.render()
    h.replay()
    expect(h.count()).toBe(1)
  }))

  test('ID/后台/pending 数据更新不影响 intent 订阅；加载期间动作到 ready 消费一次', () => run('agent', h => {
    h.render({ loaded: false })
    h.render({ loaded: false })
    expect(h.count()).toBe(0)
    h.send()
    h.render({ loaded: false })
    expect(h.count()).toBe(0)
    h.render()
    h.render()
    expect(h.count()).toBe(1)
  }))

  test('旧段不 follow，成为最新段不重放已吸收的 intent', () => run('chat', h => {
    h.render({ active: false })
    h.send()
    h.render({ active: false })
    h.render({ active: true })
    expect(h.count()).toBe(0)
    h.send()
    h.render()
    expect(h.count()).toBe(1)
  }))

  test('同次用户发送新建 tail 继承区域基线并 follow 一次', () => run('chat', h => {
    h.store.set(conversationFollowIntentAtomFamily('chat'), 5)
    h.render()
    h.render()
    expect(h.count()).toBe(1)
  }, 4))
})
