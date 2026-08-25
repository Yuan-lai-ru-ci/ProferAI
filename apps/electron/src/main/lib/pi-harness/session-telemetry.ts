import { existsSync, readFileSync } from 'node:fs'
import { loadGraph } from '../project-graph-service'
import { getPiHarnessEventsPath } from '../config-paths'
import { loadPiHarnessSnapshot, parsePiHarnessEvents } from './pi-harness-store'
import { collectPiHarnessTelemetry, type PiHarnessTelemetry } from './telemetry'

/**
 * Reads only local session ledgers and returns a sanitized aggregate suitable
 * for developer diagnostics/export. This is deliberately not an IPC handler
 * and never transmits telemetry off-device.
 */
export function collectSessionPiHarnessTelemetry(sessionId: string): PiHarnessTelemetry {
  const path = getPiHarnessEventsPath(sessionId)
  const events = existsSync(path)
    ? parsePiHarnessEvents(readFileSync(path, 'utf-8')).events
    : []
  return collectPiHarnessTelemetry({
    snapshot: loadPiHarnessSnapshot(sessionId),
    graph: loadGraph(sessionId),
    events,
  })
}
