import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendGraphEvent } from '../project-graph-service'
import { appendPiHarnessEvent } from './pi-harness-store'
import { collectSessionPiHarnessTelemetry } from './session-telemetry'
import type { PiHarnessEvent } from './types'

const roots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function useTempConfig(): void {
  const root = mkdtempSync(join(tmpdir(), 'profer-pi-harness-session-telemetry-'))
  roots.push(root)
  process.env.PROFER_CONFIG_DIR = root
}

function event(overrides: Partial<PiHarnessEvent> = {}): PiHarnessEvent {
  return {
    version: 1, eventId: 'goal', timestamp: 1, sessionId: 'session', goalId: 'goal',
    type: 'goal_created', payload: {
      activeTaskId: 'task',
      policy: { governorMode: 'shadow', permissionMode: 'bypassPermissions', maxFocusChars: 1200 },
    },
    ...overrides,
  } as PiHarnessEvent
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('session Pi Harness telemetry', () => {
  test('reads local graph and sidecar JSONL without writing a diagnostic artifact', () => {
    useTempConfig()
    appendGraphEvent('session', {
      type: 'task_created', taskId: 'task', timestamp: 1,
      payload: { subject: '任务', description: '@verify: bun test target', dependsOn: [] },
    })
    appendPiHarnessEvent('session', event())
    appendPiHarnessEvent('session', event({
      eventId: 'turn', timestamp: 2, type: 'turn_started', turnId: 'turn', payload: { activeTaskId: 'task' },
    }))
    appendPiHarnessEvent('session', event({
      eventId: 'settled', timestamp: 3, type: 'turn_state_changed', turnId: 'turn',
      payload: { state: 'settled', usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5 } },
    }))

    expect(collectSessionPiHarnessTelemetry('session')).toMatchObject({
      sessionId: 'session', usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5 },
      goals: { total: 1 }, turns: { total: 1 },
    })
  })
})
