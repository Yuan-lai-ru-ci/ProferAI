import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { SDKMessage } from '@profer/shared'
import { liveMessagesAtomFamily, liveMessagesMapAtom } from './agent-atoms'

function message(uuid: string): SDKMessage {
  return { type: 'result', subtype: 'success', uuid } as SDKMessage
}

describe('liveMessagesAtomFamily', () => {
  test('更新一个 session 时只改变该 session 的切片', () => {
    const store = createStore()
    const a = liveMessagesAtomFamily('a')
    const b = liveMessagesAtomFamily('b')
    const aBefore = store.get(a)
    const bBefore = store.get(b)

    store.set(liveMessagesMapAtom, (previous) => {
      const next = new Map(previous)
      next.set('a', [message('a-1')])
      return next
    })

    expect(store.get(a)).toEqual([message('a-1')])
    expect(store.get(a)).not.toBe(aBefore)
    expect(store.get(b)).toBe(bBefore)
  })
})
