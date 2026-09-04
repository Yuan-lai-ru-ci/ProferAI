import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { getPiHarnessEventsPath } from '../config-paths'
import { replayPiHarnessEvents } from './pi-harness-reducer'
import { PI_HARNESS_EVENT_VERSION, type PiHarnessDiagnostic, type PiHarnessEvent, type PiHarnessSnapshot } from './types'

interface ParsedPiHarnessEvents {
  events: PiHarnessEvent[]
  diagnostics: PiHarnessDiagnostic[]
}

function isEvent(value: unknown): value is PiHarnessEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return event.version === PI_HARNESS_EVENT_VERSION
    && typeof event.eventId === 'string'
    && typeof event.timestamp === 'number'
    && typeof event.sessionId === 'string'
    && typeof event.goalId === 'string'
    && typeof event.type === 'string'
    && typeof event.payload === 'object'
    && event.payload !== null
}

export function parsePiHarnessEvents(jsonl: string): ParsedPiHarnessEvents {
  const events: PiHarnessEvent[] = []
  const diagnostics: PiHarnessDiagnostic[] = []
  for (const [index, rawLine] of jsonl.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== PI_HARNESS_EVENT_VERSION) {
        diagnostics.push({ line: index + 1, code: 'unsupported_version', message: '忽略未知 Pi Harness 事件版本' })
        continue
      }
      if (!isEvent(parsed)) {
        diagnostics.push({ line: index + 1, code: 'invalid_event', message: '忽略格式无效的 Pi Harness 事件' })
        continue
      }
      events.push(parsed)
    } catch {
      diagnostics.push({ line: index + 1, code: 'invalid_json', message: '忽略损坏的 Pi Harness JSONL 行' })
    }
  }
  return { events, diagnostics }
}

export function loadPiHarnessSnapshot(sessionId: string): PiHarnessSnapshot {
  const path = getPiHarnessEventsPath(sessionId)
  if (!existsSync(path)) return replayPiHarnessEvents(sessionId, [])
  const parsed = parsePiHarnessEvents(readFileSync(path, 'utf-8'))
  return replayPiHarnessEvents(sessionId, parsed.events, parsed.diagnostics)
}

export function appendPiHarnessEvent(sessionId: string, event: PiHarnessEvent): void {
  if (event.sessionId !== sessionId) throw new Error('Pi Harness 事件会话 ID 不匹配')
  if (event.version !== PI_HARNESS_EVENT_VERSION) throw new Error('不支持的 Pi Harness 事件版本')
  const path = getPiHarnessEventsPath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8')
}

/**
 * Copies only Goals which had already settled at the selected fork boundary.
 * IDs are remapped, so a branch never shares mutable execution lineage with its source.
 */
export function copySettledPiHarnessEventsForFork(
  sourceSessionId: string,
  destSessionId: string,
  forkTimestamp: number,
): number {
  const sourcePath = getPiHarnessEventsPath(sourceSessionId)
  if (!existsSync(sourcePath)) return 0
  const parsed = parsePiHarnessEvents(readFileSync(sourcePath, 'utf-8'))
  const beforeFork = parsed.events.filter((event) => event.timestamp <= forkTimestamp)
  const snapshot = replayPiHarnessEvents(sourceSessionId, beforeFork, parsed.diagnostics)
  const settledGoalIds = new Set(Object.values(snapshot.goals).filter((goal) => goal.state === 'settled').map((goal) => goal.id))
  if (settledGoalIds.size === 0) return 0

  const goalIds = new Map<string, string>()
  const turnIds = new Map<string, string>()
  const copied = beforeFork
    .filter((event) => settledGoalIds.has(event.goalId))
    .map((event): PiHarnessEvent => {
      const goalId = goalIds.get(event.goalId) ?? randomUUID()
      goalIds.set(event.goalId, goalId)
      const turnId = 'turnId' in event && event.turnId
        ? (turnIds.get(event.turnId) ?? randomUUID())
        : undefined
      if ('turnId' in event && event.turnId && turnId) turnIds.set(event.turnId, turnId)
      const clone = { ...event, eventId: randomUUID(), sessionId: destSessionId, goalId } as Record<string, unknown>
      if (turnId) clone.turnId = turnId
      if (event.type === 'tool_fact_recorded') {
        const fact = event.payload.fact
        clone.payload = { fact: { ...fact, id: randomUUID(), goalId, turnId: turnId ?? fact.turnId } }
      }
      // Event was parsed and validated before this controlled ID/session remap.
      return clone as unknown as PiHarnessEvent
    })
  if (copied.length === 0) return 0

  const destPath = getPiHarnessEventsPath(destSessionId)
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, `${copied.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf-8')
  return copied.length
}
