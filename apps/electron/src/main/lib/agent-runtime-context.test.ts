import { describe, expect, test } from 'bun:test'
import { AgentRuntimeContextStore } from './agent-runtime-context'

describe('AgentRuntimeContextStore', () => {
  test('Given active sessions When context windows are recorded Then list returns only requested snapshots', () => {
    const store = new AgentRuntimeContextStore()
    store.setContextWindow('terra-session', 1_050_000, 100)
    store.setContextWindow('other-session', 200_000, 200)

    expect(store.list(['terra-session'])).toEqual([
      { sessionId: 'terra-session', contextWindow: 1_050_000, updatedAt: 100 },
    ])
  })

  test('Given an invalid context window When recording Then it is ignored', () => {
    const store = new AgentRuntimeContextStore()
    store.setContextWindow('session', 0)

    expect(store.list()).toEqual([])
  })

  test('Given a completed session When cleared Then it is excluded from future snapshots', () => {
    const store = new AgentRuntimeContextStore()
    store.setContextWindow('session', 1_050_000)
    store.clear('session')

    expect(store.list()).toEqual([])
  })
})
