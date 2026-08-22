import { describe, expect, test } from 'bun:test'
import { mapPiHarnessLifecycleEvent } from './pi-harness-lifecycle'

describe('Pi Harness lifecycle mapper', () => {
  test('maps agent-end and native retry boundaries without creating a new Turn', () => {
    expect(mapPiHarnessLifecycleEvent({ type: 'agent_end' }, 1)).toEqual([{ type: 'model_call_completed', timestamp: 1 }])
    expect(mapPiHarnessLifecycleEvent({ type: 'auto_retry_start' }, 2)).toEqual([{ type: 'retry_started', timestamp: 2 }])
    expect(mapPiHarnessLifecycleEvent({ type: 'auto_retry_end' }, 3)).toEqual([{ type: 'retry_finished', timestamp: 3 }])
  })

  test('maps compaction boundaries and distinguishes overflow recovery', () => {
    expect(mapPiHarnessLifecycleEvent({ type: 'compaction_start' }, 1)).toEqual([{ type: 'compaction_started', timestamp: 1 }])
    expect(mapPiHarnessLifecycleEvent({ type: 'compaction_end', result: {}, willRetry: true }, 2)).toEqual([
      { type: 'compaction_finished', timestamp: 2, recovered: true },
    ])
    expect(mapPiHarnessLifecycleEvent({ type: 'compaction_end', aborted: true, result: {}, willRetry: true }, 3)).toEqual([
      { type: 'compaction_finished', timestamp: 3, recovered: false },
    ])
  })

  test('ignores unrelated Pi events', () => {
    expect(mapPiHarnessLifecycleEvent({ type: 'message_end' })).toEqual([])
  })
})
