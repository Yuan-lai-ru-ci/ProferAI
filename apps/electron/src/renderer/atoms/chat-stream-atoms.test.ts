import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  conversationStreamStateAtomFamily,
  streamingConversationIdsAtom,
  streamingStatesAtom,
  type ConversationStreamState,
} from './chat-atoms'

function state(overrides: Partial<ConversationStreamState> = {}): ConversationStreamState {
  return {
    runId: 'run-1',
    streaming: true,
    content: '',
    reasoning: '',
    toolActivities: [],
    ...overrides,
  }
}

describe('streamingConversationIdsAtom', () => {
  test('内容增量不改变集合引用，避免侧栏/标签栏跟着每个 token 重渲染', () => {
    const store = createStore()
    store.set(streamingStatesAtom, new Map([['conv-a', state()]]))
    const before = store.get(streamingConversationIdsAtom)

    store.set(streamingStatesAtom, new Map([['conv-a', state({ content: 'hello' })]]))
    const afterContent = store.get(streamingConversationIdsAtom)

    expect(afterContent).toBe(before)
  })

  test('集合成员变化时返回新引用', () => {
    const store = createStore()
    store.set(streamingStatesAtom, new Map([['conv-a', state()]]))
    const before = store.get(streamingConversationIdsAtom)

    store.set(streamingStatesAtom, new Map([
      ['conv-a', state()],
      ['conv-b', state({ runId: 'run-2' })],
    ]))
    const after = store.get(streamingConversationIdsAtom)

    expect(after).not.toBe(before)
    expect([...after].sort()).toEqual(['conv-a', 'conv-b'])
  })
})

describe('conversationStreamStateAtomFamily', () => {
  test('其他对话的流式更新不改变本对话切片引用', () => {
    const store = createStore()
    const convA = state()
    store.set(streamingStatesAtom, new Map([['conv-a', convA]]))
    const slice = conversationStreamStateAtomFamily('conv-a')
    const before = store.get(slice)

    // 真实链路里只有被更新的对话会换新对象，其他对话的 state 引用保持不变。
    store.set(streamingStatesAtom, new Map([
      ['conv-a', convA],
      ['conv-b', state({ runId: 'run-2', content: '另一路的输出' })],
    ]))

    expect(store.get(slice)).toBe(before)
  })

  test('本对话的增量会产出新的切片', () => {
    const store = createStore()
    store.set(streamingStatesAtom, new Map([['conv-a', state()]]))
    const slice = conversationStreamStateAtomFamily('conv-a')

    store.set(streamingStatesAtom, new Map([['conv-a', state({ content: '第一段' })]]))

    expect(store.get(slice)?.content).toBe('第一段')
  })
})
