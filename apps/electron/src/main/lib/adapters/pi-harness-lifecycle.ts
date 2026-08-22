/** Passive Pi runtime lifecycle signals consumed by the Host Harness. */

export type PiHarnessLifecycleEvent =
  | { type: 'turn_running'; timestamp: number }
  | { type: 'model_call_completed'; timestamp: number }
  | { type: 'retry_started'; timestamp: number }
  | { type: 'retry_finished'; timestamp: number }
  | { type: 'compaction_started'; timestamp: number }
  | { type: 'compaction_finished'; timestamp: number; recovered: boolean }

export type PiHarnessLifecycleObserver = (event: PiHarnessLifecycleEvent) => void

type PiLifecycleSourceEvent = {
  type: string
  aborted?: boolean
  result?: unknown
  willRetry?: boolean
}

/**
 * Normalizes only lifecycle facts. The observer never has access to Session or
 * prompt methods, so it cannot re-enter Pi or schedule another model turn.
 */
export function mapPiHarnessLifecycleEvent(
  event: PiLifecycleSourceEvent,
  timestamp = Date.now(),
): PiHarnessLifecycleEvent[] {
  switch (event.type) {
    case 'agent_end':
      return [{ type: 'model_call_completed', timestamp }]
    case 'auto_retry_start':
      return [{ type: 'retry_started', timestamp }]
    case 'auto_retry_end':
      return [{ type: 'retry_finished', timestamp }]
    case 'compaction_start':
      return [{ type: 'compaction_started', timestamp }]
    case 'compaction_end':
      return [{ type: 'compaction_finished', timestamp, recovered: !event.aborted && event.result !== undefined && Boolean(event.willRetry) }]
    default:
      return []
  }
}
