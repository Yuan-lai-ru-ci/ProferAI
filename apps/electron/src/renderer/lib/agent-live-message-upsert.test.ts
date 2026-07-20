import { describe, expect, test } from 'bun:test'
import { upsertLiveMessageByUuid } from './agent-live-message-upsert'

type Message = {
  uuid: string
  _partial?: boolean
  text: string
}

describe('upsertLiveMessageByUuid', () => {
  test('replaces successive Pi partial frames and the final message sharing a UUID', () => {
    const partialA: Message = { uuid: 'A', _partial: true, text: 'a' }
    const expandedPartialA: Message = { uuid: 'A', _partial: true, text: 'abc' }
    const finalA: Message = { uuid: 'A', text: 'abcdef' }

    const afterFirstPartial = upsertLiveMessageByUuid([], partialA)
    const afterExpandedPartial = upsertLiveMessageByUuid(afterFirstPartial, expandedPartialA)
    const afterFinal = upsertLiveMessageByUuid(afterExpandedPartial, finalA)

    expect(afterFirstPartial).toEqual([partialA])
    expect(afterExpandedPartial).toEqual([expandedPartialA])
    expect(afterFinal).toEqual([finalA])
    expect(afterFinal).toHaveLength(1)
    expect(afterFinal[0]!._partial).toBeUndefined()
  })

  test('replaces an existing final when the incoming same-UUID message is partial', () => {
    const finalA: Message = { uuid: 'A', text: 'abcdef' }
    const partialA: Message = { uuid: 'A', _partial: true, text: 'abc' }

    expect(upsertLiveMessageByUuid([finalA], partialA)).toEqual([partialA])
  })

  test('keeps final-to-final UUID duplicates de-duplicated', () => {
    const finalA: Message = { uuid: 'A', text: 'abcdef' }
    const duplicateFinalA: Message = { uuid: 'A', text: 'ignored' }
    const current = [finalA]

    expect(upsertLiveMessageByUuid(current, duplicateFinalA)).toBe(current)
  })
})
