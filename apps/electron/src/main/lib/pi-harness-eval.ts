import type { PiHarnessDecision, PiHarnessToolResult } from './pi-harness'
import { createPiHarness } from './pi-harness'

export interface PiHarnessEvalCase {
  name: string
  tools: PiHarnessToolResult[]
  blocked?: boolean
  expected: Pick<PiHarnessDecision, 'action' | 'reason' | 'validationAttempted'>
}

export interface PiHarnessEvalSummary {
  total: number
  followUpRate: number
  validatedRate: number
  blockedRate: number
  reasons: Record<string, number>
}

export function replayPiHarnessCase(testCase: PiHarnessEvalCase): PiHarnessDecision {
  const harness = createPiHarness({ userPrompt: testCase.name })
  for (const tool of testCase.tools) harness.recordToolResult(tool)
  if (testCase.blocked) harness.markBlocked()
  return harness.createDecision()
}

export function summarizePiHarnessDecisions(decisions: PiHarnessDecision[]): PiHarnessEvalSummary {
  const reasons: Record<string, number> = {}
  for (const decision of decisions) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1
  const total = decisions.length
  const count = (predicate: (decision: PiHarnessDecision) => boolean) => decisions.filter(predicate).length
  return {
    total,
    followUpRate: total === 0 ? 0 : count((decision) => decision.action === 'follow_up') / total,
    validatedRate: total === 0 ? 0 : count((decision) => decision.reason === 'validated') / total,
    blockedRate: total === 0 ? 0 : count((decision) => decision.reason === 'blocked_or_failed') / total,
    reasons,
  }
}
