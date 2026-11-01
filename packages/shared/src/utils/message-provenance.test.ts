import { describe, expect, test } from 'bun:test'
import { getMessageAuthor, projectMessageProvenance, readMessageProvenance } from './message-provenance'

const provenance = {
  schemaVersion: 1 as const,
  messageId: 'message-1',
  author: { type: 'agent' as const, id: 'worker' },
  runId: 'run-1',
  taskId: 'task-1',
  triggerId: 'trigger-1',
  source: { type: 'session' as const, id: 'source-session' },
}

describe('message provenance', () => {
  test('valid provenance returns only the canonical fields', () => {
    expect(readMessageProvenance({ ...provenance, authorization: { token: 'secret' }, absolutePath: '/private' })).toEqual(provenance)
    expect(projectMessageProvenance({ ...provenance, authorization: { token: 'secret' }, absolutePath: '/private' })).toEqual(provenance)
  })

  test('invalid provenance and legacy messages have an explicit unknown author', () => {
    expect(readMessageProvenance({ ...provenance, schemaVersion: 2 })).toBeUndefined()
    expect(readMessageProvenance({ ...provenance, author: { type: 'provider-role', id: 'user' } })).toBeUndefined()
    expect(getMessageAuthor(undefined)).toEqual({ type: 'unknown' })
    expect(getMessageAuthor({ author: { type: 'agent' }, runId: 'run-1' })).toEqual({ type: 'unknown' })
  })
})
