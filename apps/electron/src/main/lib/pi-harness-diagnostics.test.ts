import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPiHarnessDiagnostic, toPiHarnessDiagnosticEvent } from './pi-harness-diagnostics'

const decision = {
  action: 'follow_up' as const,
  reason: 'source_changes_unverified' as const,
  prompt: '不应写入诊断事件',
  pendingPaths: ['src/a.ts', 'src/b.ts'],
  validationAttempted: false,
}

describe('Pi Harness diagnostics', () => {
  test('事件脱敏且保留结构化决策字段', () => {
    const event = toPiHarnessDiagnosticEvent('session-1', decision, new Date('2026-08-07T05:00:00.000Z'))
    expect(event).toEqual({
      schemaVersion: 2,
      timestamp: '2026-08-07T05:00:00.000Z',
      sessionId: 'session-1',
      runtime: 'pi',
      action: 'follow_up',
      reason: 'source_changes_unverified',
      pendingPathCount: 2,
      pendingPaths: ['src/a.ts', 'src/b.ts'],
      validationAttempted: false,
    })
    expect(JSON.stringify(event)).not.toContain('不应写入')
  })

  test('runtime 参数透传（B1-5：Claude 侧事件标记 runtime=claude）', () => {
    const event = toPiHarnessDiagnosticEvent('session-1', decision, new Date('2026-08-07T05:00:00.000Z'), undefined, 'claude')
    expect(event.runtime).toBe('claude')
    // 缺省仍为 pi，兼容既有调用方
    expect(toPiHarnessDiagnosticEvent('session-2', decision).runtime).toBe('pi')
  })

  test('turnId 可选透传，sessionId 超长截断', () => {
    const event = toPiHarnessDiagnosticEvent('x'.repeat(500), decision, new Date('2026-08-07T05:00:00.000Z'), 'turn-42')
    expect(event.turnId).toBe('turn-42')
    expect(event.sessionId.length).toBeLessThanOrEqual(128)
  })

  test('诊断 sink 追加合法 JSONL，写入失败不抛出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-harness-'))
    const file = join(dir, 'nested', 'events.jsonl')
    appendPiHarnessDiagnostic('session-1', decision, file)
    appendPiHarnessDiagnostic('session-2', { ...decision, action: 'none', reason: 'validated' }, file)
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0].schemaVersion).toBe(2)
    const directoryTarget = join(dir, 'directory-target')
    mkdirSync(directoryTarget)
    expect(() => appendPiHarnessDiagnostic('session-3', decision, directoryTarget)).not.toThrow()
  })
})
