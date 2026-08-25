import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiHarnessEventsPath } from '../config-paths'
import { appendPiHarnessEvent, copySettledPiHarnessEventsForFork, loadPiHarnessSnapshot, parsePiHarnessEvents } from './pi-harness-store'
import { PI_HARNESS_EVENT_VERSION, type PiHarnessEvent, type PiHarnessPolicySnapshot } from './types'

const roots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR
const policy: PiHarnessPolicySnapshot = { governorMode: 'shadow', permissionMode: 'bypassPermissions', maxFocusChars: 1200 }

function useTempConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-pi-harness-store-'))
  roots.push(root)
  process.env.PROFER_CONFIG_DIR = root
  return root
}

function event(overrides: Partial<PiHarnessEvent> = {}): PiHarnessEvent {
  return {
    version: PI_HARNESS_EVENT_VERSION,
    eventId: 'event-1',
    timestamp: 100,
    sessionId: 'source',
    goalId: 'goal-1',
    type: 'goal_created',
    payload: { policy },
    ...overrides,
  } as PiHarnessEvent
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Pi Harness sidecar store', () => {
  test('appends and replays a versioned event ledger', () => {
    useTempConfig()
    appendPiHarnessEvent('source', event())
    appendPiHarnessEvent('source', event({
      eventId: 'turn-1', timestamp: 101, type: 'turn_started', turnId: 'turn-1', payload: { activeTaskId: 'task-1' },
    }))
    appendPiHarnessEvent('source', event({
      eventId: 'turn-2', timestamp: 102, type: 'turn_state_changed', turnId: 'turn-1',
      payload: { state: 'settled', usage: { modelCalls: 1, inputTokens: 2, outputTokens: 3 } },
    }))

    const snapshot = loadPiHarnessSnapshot('source')
    expect(snapshot.goals['goal-1']).toMatchObject({ state: 'active', policy })
    expect(snapshot.turns['turn-1']).toMatchObject({ state: 'settled', usage: { modelCalls: 1, inputTokens: 2, outputTokens: 3, retries: 0 } })
    expect(snapshot.diagnostics).toEqual([])
    expect(readFileSync(getPiHarnessEventsPath('source'), 'utf-8')).toContain('goal_created')
  })

  test('skips corrupt, unsupported and duplicate event rows while preserving valid state', () => {
    useTempConfig()
    const path = getPiHarnessEventsPath('source')
    const valid = JSON.stringify(event())
    writeFileSync(path, `${valid}\nnot-json\n${JSON.stringify({ ...event({ eventId: 'future' }), version: 2 })}\n${valid}\n`, 'utf-8')

    const snapshot = loadPiHarnessSnapshot('source')
    expect(snapshot.goals['goal-1']).toBeDefined()
    expect(snapshot.diagnostics.map((item) => item.code)).toEqual(['invalid_json', 'unsupported_version', 'duplicate_event'])
  })

  test('rejects an event which attempts to append under another session', () => {
    useTempConfig()
    expect(() => appendPiHarnessEvent('destination', event())).toThrow('会话 ID 不匹配')
  })

  test('forks only goals settled before the branch boundary and remaps mutable IDs', () => {
    useTempConfig()
    appendPiHarnessEvent('source', event({ goalId: 'settled-goal', eventId: 'settled-created', timestamp: 10 }))
    appendPiHarnessEvent('source', event({ goalId: 'settled-goal', eventId: 'settled-turn', timestamp: 11, type: 'turn_started', turnId: 'old-turn', payload: {} }))
    appendPiHarnessEvent('source', event({ goalId: 'settled-goal', eventId: 'settled-end', timestamp: 12, type: 'turn_state_changed', turnId: 'old-turn', payload: { state: 'settled' } }))
    appendPiHarnessEvent('source', event({ goalId: 'settled-goal', eventId: 'settled-goal-end', timestamp: 13, type: 'goal_settled', payload: { reason: 'done' } }))
    appendPiHarnessEvent('source', event({ goalId: 'active-goal', eventId: 'active-created', timestamp: 20 }))

    const copied = copySettledPiHarnessEventsForFork('source', 'destination', 20)
    const destination = loadPiHarnessSnapshot('destination')

    expect(copied).toBe(4)
    expect(Object.keys(destination.goals)).toHaveLength(1)
    expect(destination.goals['settled-goal']).toBeUndefined()
    expect(Object.values(destination.goals)[0]).toMatchObject({ state: 'settled', sessionId: 'destination' })
    expect(Object.values(destination.turns)[0]?.id).not.toBe('old-turn')
    expect(existsSync(getPiHarnessEventsPath('destination'))).toBe(true)
  })

  test('returns parse diagnostics without throwing for an empty or malformed ledger', () => {
    expect(parsePiHarnessEvents('').events).toEqual([])
    expect(parsePiHarnessEvents('{').diagnostics[0]).toMatchObject({ code: 'invalid_json', line: 1 })
  })
})
