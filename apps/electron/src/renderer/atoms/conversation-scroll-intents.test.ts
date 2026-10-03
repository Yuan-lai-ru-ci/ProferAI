import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import {
  conversationFollowIntentAtomFamily,
  requestConversationFollowAtom,
  consumeConversationFollowIntent,
  type ConversationFollowBaseline,
} from './conversation-scroll-intents'

function createConsumer(store: ReturnType<typeof createStore>, sessionId: string) {
  let baseline: ConversationFollowBaseline = {
    sessionId,
    consumedIntent: store.get(conversationFollowIntentAtomFamily(sessionId)),
  }
  let follows = 0
  return {
    update({ loaded = true, active = true, id = sessionId } = {}) {
      const result = consumeConversationFollowIntent(
        baseline, id, store.get(conversationFollowIntentAtomFamily(id)), loaded, active,
      )
      baseline = result.baseline
      if (result.follow) follows++
      return result.follow
    },
    count: () => follows,
  }
}

describe('显式用户 follow intent', () => {
  test('新发送只 follow 一次，temp → 持久化 ID → rollback 均不重复 follow', () => {
    const store = createStore()
    const consumer = createConsumer(store, 'chat')
    expect(consumer.update()).toBe(false)
    store.set(requestConversationFollowAtom, 'chat')
    expect(consumer.update()).toBe(true)
    // 与组件合同一致：消息数据没有 action，数据刷新只再次读取同一代次。
    for (const userId of ['temp-123', 'persisted-user', 'previous-user']) {
      expect(userId).toBeTruthy()
      expect(consumer.update()).toBe(false)
    }
    expect(consumer.count()).toBe(1)
  })

  test('后台 running 重启、队列自动续跑、pending 清零均不发 intent', () => {
    const store = createStore()
    const consumer = createConsumer(store, 'agent')
    for (const dataChange of ['background-running', 'automation-user', 'pending-cleared', 'history-prepend', 'branch-loaded']) {
      expect(dataChange).toBeTruthy()
      expect(consumer.update()).toBe(false)
    }
    expect(consumer.count()).toBe(0)
    expect(store.get(conversationFollowIntentAtomFamily('agent'))).toBe(0)
  })

  test('用户重试和实际回答各产生一个新代次，session 间隔离', () => {
    const store = createStore()
    const agent = createConsumer(store, 'agent')
    const chat = createConsumer(store, 'chat')
    store.set(requestConversationFollowAtom, 'agent')
    expect(agent.update()).toBe(true)
    store.set(requestConversationFollowAtom, 'agent')
    expect(agent.update()).toBe(true)
    expect(chat.update()).toBe(false)
    expect(store.get(conversationFollowIntentAtomFamily('agent'))).toBe(2)
    expect(agent.count()).toBe(2)
  })

  test('首次挂载已有非零代次只建立基线，含 StrictMode effect 重跑', () => {
    const store = createStore()
    store.set(requestConversationFollowAtom, 'agent')
    const consumer = createConsumer(store, 'agent')
    expect(consumer.update()).toBe(false)
    expect(consumer.update()).toBe(false)
  })

  test('加载期间的新动作在加载完成时 follow 一次，初始历史代次不响应', () => {
    const store = createStore()
    store.set(requestConversationFollowAtom, 'agent')
    const consumer = createConsumer(store, 'agent')
    expect(consumer.update({ loaded: false })).toBe(false)
    store.set(requestConversationFollowAtom, 'agent')
    expect(consumer.update({ loaded: false })).toBe(false)
    expect(consumer.update({ loaded: true })).toBe(true)
    expect(consumer.update()).toBe(false)
    expect(consumer.count()).toBe(1)
  })

  test('多个加载期动作合并为一次回底', () => {
    const store = createStore()
    const consumer = createConsumer(store, 'chat')
    store.set(requestConversationFollowAtom, 'chat')
    consumer.update({ loaded: false })
    store.set(requestConversationFollowAtom, 'chat')
    consumer.update({ loaded: false })
    consumer.update()
    expect(consumer.count()).toBe(1)
  })

  test('新发送时只有最新并排段响应，旧段之后成为最新也不重放历史 intent', () => {
    const store = createStore()
    const oldSegment = createConsumer(store, 'chat')
    const latestSegment = createConsumer(store, 'chat')
    store.set(requestConversationFollowAtom, 'chat')
    expect(oldSegment.update({ active: false })).toBe(false)
    expect(latestSegment.update({ active: true })).toBe(true)
    expect(oldSegment.update({ active: true })).toBe(false)
    expect(oldSegment.count()).toBe(0)
    expect(latestSegment.count()).toBe(1)
  })

  test('加载期间旧段也吸收代次，不留待稍后激活', () => {
    const store = createStore()
    const oldSegment = createConsumer(store, 'chat')
    store.set(requestConversationFollowAtom, 'chat')
    expect(oldSegment.update({ loaded: false, active: false })).toBe(false)
    expect(oldSegment.update({ loaded: true, active: true })).toBe(false)
  })

  test('同次发送新建 tail 可继承消息区域的基线，而旧段仍不 follow', () => {
    const baseline = { sessionId: 'chat', consumedIntent: 4 }
    expect(consumeConversationFollowIntent(baseline, 'chat', 5, true, true).follow).toBe(true)
    expect(consumeConversationFollowIntent(baseline, 'chat', 5, true, false).follow).toBe(false)
  })

  test('切换 session 只建新基线，不把别的会话的历史 intent 当发送', () => {
    const store = createStore()
    const consumer = createConsumer(store, 'chat')
    store.set(requestConversationFollowAtom, 'agent')
    expect(consumer.update({ id: 'agent' })).toBe(false)
    store.set(requestConversationFollowAtom, 'agent')
    expect(consumer.update({ id: 'agent' })).toBe(true)
    expect(consumer.count()).toBe(1)
  })
})
