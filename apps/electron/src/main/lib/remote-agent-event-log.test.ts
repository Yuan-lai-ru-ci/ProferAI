import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload } from '@profer/shared'
import { RemoteAgentEventLog } from './remote-agent-event-log'

const payload = (text: string): AgentStreamPayload => ({
  kind: 'profer_event',
  event: { type: 'run_idle', sessionId: text },
} as AgentStreamPayload)

describe('RemoteAgentEventLog', () => {
  test('assigns monotonically increasing event ids and replays after cursor', () => {
    const log = new RemoteAgentEventLog(10, 60_000)
    const first = log.append('session-a', payload('a'), 1_000)
    const second = log.append('session-b', payload('b'), 1_001)

    expect(first.eventId).toBe(1)
    expect(second.eventId).toBe(2)
    expect(log.replayAfter(1).records.map((record) => record.eventId)).toEqual([2])
    expect(log.replayAfter(1).fromEventId).toBe(2)
    expect(log.replayAfter(1).toEventId).toBe(2)
  })

  test('does not replay historical events for a first connection', () => {
    const log = new RemoteAgentEventLog(10, 60_000)
    log.append('session-a', payload('a'), 1_000)

    const replay = log.replayAfter(null)

    expect(replay.records).toEqual([])
    expect(replay.requiresSnapshot).toBe(false)
    expect(replay.latestEventId).toBe(1)
  })

  test('requires a snapshot when the cursor falls outside the retained window', () => {
    const log = new RemoteAgentEventLog(2, 60_000)
    log.append('session-a', payload('a'), 1_000)
    log.append('session-a', payload('b'), 1_001)
    log.append('session-a', payload('c'), 1_002)

    const replay = log.replayAfter(0)

    expect(replay.records).toEqual([])
    expect(replay.requiresSnapshot).toBe(true)
    expect(replay.oldestEventId).toBe(2)
    expect(replay.latestEventId).toBe(3)
  })

  test('prunes events by age and keeps the hard event limit', () => {
    const log = new RemoteAgentEventLog(2, 100)
    log.append('session-a', payload('a'), 1_000)
    log.append('session-a', payload('b'), 1_050)
    log.append('session-a', payload('c'), 1_100)
    log.append('session-a', payload('d'), 1_101)

    expect(log.getOldestEventId()).toBe(3)
    expect(log.getLatestEventId()).toBe(4)
    expect(log.replayAfter(2).records.map((record) => record.eventId)).toEqual([3, 4])
  })

  test('rejects invalid cursors instead of silently replaying an incomplete stream', () => {
    const log = new RemoteAgentEventLog(10, 60_000)
    log.append('session-a', payload('a'), 1_000)

    expect(log.replayAfter(-1).requiresSnapshot).toBe(true)
    expect(log.replayAfter(1.5).requiresSnapshot).toBe(true)
  })
})
