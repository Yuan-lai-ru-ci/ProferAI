import { describe, expect, test } from 'bun:test'
import cases from '../../../test/fixtures/pi-harness-eval-cases.json'
import { replayPiHarnessCase, summarizePiHarnessDecisions, summarizePiHarnessMatrix, type PiHarnessEvalCase } from './pi-harness-eval'

describe('Pi Harness replay eval', () => {
  test('脱敏 corpus 的预期决策全部通过', () => {
    const typedCases = cases as PiHarnessEvalCase[]
    const decisions = typedCases.map((testCase) => {
      const decision = replayPiHarnessCase(testCase)
      expect(decision).not.toBeNull()
      expect(decision).toMatchObject(testCase.expected)
      return decision!
    })
    expect(summarizePiHarnessDecisions(decisions)).toEqual({
      total: 18,
      skipped: 0,
      followUpRate: 9 / 18,
      validatedRate: 6 / 18,
      blockedRate: 1 / 18,
      reasons: {
        read_only: 2,
        source_changes_unverified: 7,
        validated: 6,
        documents_unverified: 2,
        blocked_or_failed: 1,
      },
    })
  })

  test('坏数据回放降级为 null 而非崩溃', () => {
    const bad = { name: 42, input: 'not-an-object', outcome: 'maybe' }
    const broken = replayPiHarnessCase({ name: 'bad', tools: [bad as unknown as never], expected: { action: 'none', reason: 'read_only', validationAttempted: false } })
    expect(broken).toBeNull()
    const ok = replayPiHarnessCase({ name: 'ok', tools: [{ name: 'read', input: { path: 'a.ts' } }], expected: { action: 'none', reason: 'read_only', validationAttempted: false } })
    expect(ok).not.toBeNull()
  })

  test('交叉矩阵按 reason × action 归并', () => {
    const { actionByReason } = summarizePiHarnessMatrix([
      { action: 'none', reason: 'read_only', pendingPaths: [], validationAttempted: false },
      { action: 'follow_up', reason: 'source_changes_unverified', pendingPaths: [], validationAttempted: false },
      { action: 'follow_up', reason: 'source_changes_unverified', pendingPaths: [], validationAttempted: false },
    ])
    expect(actionByReason.read_only).toEqual({ none: 1 })
    expect(actionByReason.source_changes_unverified).toEqual({ follow_up: 2 })
  })

  test('空集合汇总不产生 NaN', () => {
    expect(summarizePiHarnessDecisions([])).toEqual({
      total: 0,
      skipped: 0,
      followUpRate: 0,
      validatedRate: 0,
      blockedRate: 0,
      reasons: {},
    })
  })
})
