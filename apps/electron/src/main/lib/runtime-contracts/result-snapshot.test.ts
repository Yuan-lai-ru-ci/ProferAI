import { describe, expect, test } from 'bun:test'
import { createRuntimeResultSnapshot } from '../agent-runtime-result-snapshot'

describe('runtime result snapshot', () => {
  test('retains only the latest complete assistant answer; partial and replay cannot replace it', () => {
    const snapshot = createRuntimeResultSnapshot()
    for (let index = 0; index < 500; index++) {
      snapshot.observe({ type: 'assistant', uuid: `answer-${index}`, message: { content: [{ type: 'text', text: `answer ${index}` }] } } as never)
    }
    snapshot.observe({ type: 'assistant', uuid: 'partial', _partial: true, message: { content: [{ type: 'text', text: 'unfinished' }] } } as never)
    snapshot.observe({ type: 'assistant', uuid: 'replay', isReplay: true, message: { content: [{ type: 'text', text: 'stale' }] } } as never)
    expect(snapshot.messages()).toEqual([{ id: 'answer-499', role: 'assistant', content: 'answer 499', createdAt: expect.any(Number) }])
    snapshot.clear()
    expect(snapshot.messages()).toEqual([])
  })
})
