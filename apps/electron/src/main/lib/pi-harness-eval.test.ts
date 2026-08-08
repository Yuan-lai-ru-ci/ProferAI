import { describe, expect, test } from 'bun:test'
import cases from '../../../test/fixtures/pi-harness-eval-cases.json'
import { replayPiHarnessCase, summarizePiHarnessDecisions, type PiHarnessEvalCase } from './pi-harness-eval'

describe('Pi Harness replay eval', () => {
  test('脱敏 corpus 的预期决策全部通过', () => {
    const typedCases = cases as PiHarnessEvalCase[]
    const decisions = typedCases.map((testCase) => {
      const decision = replayPiHarnessCase(testCase)
      expect(decision).toMatchObject(testCase.expected)
      return decision
    })
    expect(summarizePiHarnessDecisions(decisions)).toEqual({
      total: 9,
      followUpRate: 3 / 9,
      validatedRate: 3 / 9,
      blockedRate: 1 / 9,
      reasons: {
        read_only: 2,
        source_changes_unverified: 2,
        validated: 3,
        documents_unverified: 1,
        blocked_or_failed: 1,
      },
    })
  })

  test('空集合汇总不产生 NaN', () => {
    expect(summarizePiHarnessDecisions([])).toEqual({
      total: 0,
      followUpRate: 0,
      validatedRate: 0,
      blockedRate: 0,
      reasons: {},
    })
  })
})
