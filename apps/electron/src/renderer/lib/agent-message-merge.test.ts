import { describe, expect, test } from 'bun:test'
import { mergeMessagesByUuid } from './agent-message-merge'

type Message = {
  type: 'user' | 'assistant'
  uuid?: string
  text: string
}

describe('mergeMessagesByUuid', () => {
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
