import { describe, expect, test } from 'bun:test'
import { namespaceCoreSessionId, parseCoreSessionId } from './core-target-service'

describe('Core session namespace', () => {
  test('keeps remote session IDs bound to their owning Core identity', () => {
    const localId = 'same-session-id'
    const remoteId = namespaceCoreSessionId(localId, 'linux/core:one')
    expect(remoteId).not.toBe(localId)
    expect(parseCoreSessionId(remoteId)).toEqual({ coreId: 'linux/core:one', sessionId: localId })
    expect(parseCoreSessionId(namespaceCoreSessionId(localId, 'other-core'))?.coreId).not.toBe('linux/core:one')
  })

  test('rejects malformed or unnamespaced IDs', () => {
    expect(parseCoreSessionId('same-session-id')).toBeNull()
    expect(parseCoreSessionId('core:%E0%A4%A:id')).toBeNull()
  })
})
