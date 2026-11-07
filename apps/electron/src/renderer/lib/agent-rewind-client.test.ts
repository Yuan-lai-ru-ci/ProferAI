import { describe, expect, test } from 'bun:test'
import { RewindRequestCoordinator } from './agent-rewind-client'

describe('RewindRequestCoordinator', () => {
  test('重复点击时只接受一个 prepare 请求', async () => {
    let calls = 0
    let resolve!: (value: { plan: never }) => void
    const pending = new Promise<{ plan: never }>((done) => { resolve = done })
    const client = {
      prepare: async () => { calls += 1; return pending },
      execute: async () => { throw new Error('unused') },
      undo: async () => { throw new Error('unused') },
    }
    const coordinator = new RewindRequestCoordinator()
    const first = coordinator.prepare(client, { sessionId: 's', mode: 'conversation', target: { kind: 'session-start' } })
    const second = coordinator.prepare(client, { sessionId: 's', mode: 'conversation', target: { kind: 'session-start' } })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(calls).toBe(1)
    resolve({ plan: undefined as never })
    await first
    expect(coordinator.busy).toBe(false)
  })
})
