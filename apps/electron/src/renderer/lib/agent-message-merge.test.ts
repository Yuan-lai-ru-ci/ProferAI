import { describe, expect, test } from 'bun:test'
import { mergeMessagesByUuid } from './agent-message-merge'
import { orderTranscriptMessages } from './agent-transcript-order'

type Message = {
  type: 'user' | 'assistant'
  uuid?: string
  text: string
}

describe('mergeMessagesByUuid', () => {
  test('迟到副本更新内容和来源但不能把提问的时间改到回复之后', () => {
    const user = { type: 'user', uuid: 'question', _createdAt: 100, text: '你好' }
    const reply = { type: 'assistant', uuid: 'reply', _createdAt: 200, text: '你好！' }
    const late = { ...user, _createdAt: 300, text: '你好（完整版）', _provenance: { author: { type: 'user' } } }
    const result = orderTranscriptMessages(mergeMessagesByUuid([user, reply], [late]))
    expect(result.map(message => message.uuid)).toEqual(['question', 'reply'])
    expect(result[0]).toMatchObject({ text: '你好（完整版）', _createdAt: 100, _provenance: late._provenance })
    expect(late._createdAt).toBe(300)
    expect(user.text).toBe('你好')
  })

  test('已有无时间历史按物理位置显示，迟到实时副本不能给它补一个晚于回复的时间', () => {
    type LegacyMessage = { type: string; uuid: string; _createdAt?: number }
    const previous: LegacyMessage = { type: 'assistant', uuid: 'previous', _createdAt: 50 }
    const question: LegacyMessage = { type: 'user', uuid: 'q' }
    const answer: LegacyMessage = { type: 'assistant', uuid: 'a', _createdAt: 200 }
    const late: LegacyMessage = { ...question, _createdAt: 300 }
    const merged = mergeMessagesByUuid([previous, question, answer], [late])
    expect(orderTranscriptMessages(merged).map(message => message.uuid)).toEqual(['previous', 'q', 'a'])
    expect(merged[1]?._createdAt).toBeUndefined()
    expect(late._createdAt).toBe(300)
  })

  test('流式、结束刷新、切回历史保持同一顺序；缺时间副本不清除已知时间', () => {
    type TimedMessage = { type: string; uuid: string; _createdAt?: number; _partial?: boolean }
    const user: TimedMessage = { type: 'user', uuid: 'q', _createdAt: 100 }
    const partial: TimedMessage = { type: 'assistant', uuid: 'a', _createdAt: 150, _partial: true }
    const final: TimedMessage = { ...partial, _createdAt: 200, _partial: false }
    const during = mergeMessagesByUuid([user], [partial])
    const finished = mergeMessagesByUuid(during, [{ type: 'user', uuid: 'q' }, final])
    const refreshed = mergeMessagesByUuid([user, final], finished)
    const switched = mergeMessagesByUuid([user, final], [])
    for (const messages of [during, finished, refreshed, switched]) {
      expect(orderTranscriptMessages(messages).map(message => message.uuid)).toEqual(['q', 'a'])
      expect(messages[0]?._createdAt).toBe(100)
    }
    expect(finished[1]).toMatchObject({ _partial: false, _createdAt: 150 })
  })

  test('keeps one live /compact copy at its persisted transcript position after a session switch', () => {
    const before: Message = { type: 'user', uuid: 'before', text: 'before' }
    const persistedCompact: Message = { type: 'user', uuid: 'compact-1', text: '/compact' }
    const after: Message = { type: 'assistant', uuid: 'after', text: 'after' }
    const liveCompact: Message = { type: 'user', uuid: 'compact-1', text: '/compact' }

    expect(mergeMessagesByUuid([before, persistedCompact, after], [liveCompact]))
      .toEqual([before, liveCompact, after])
  })

  test('keeps equal text from distinct user actions', () => {
    const first: Message = { type: 'user', uuid: 'compact-1', text: '/compact' }
    const second: Message = { type: 'user', uuid: 'compact-2', text: '/compact' }

    expect(mergeMessagesByUuid([first], [second])).toEqual([first, second])
  })

  test('keeps distinct messages that do not have UUIDs', () => {
    const first: Message = { type: 'user', text: '/compact' }
    const second: Message = { type: 'user', text: '/compact' }

    expect(mergeMessagesByUuid([first], [second])).toEqual([first, second])
  })
})
