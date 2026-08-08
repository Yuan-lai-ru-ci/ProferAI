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
  skipped: number
  followUpRate: number
  validatedRate: number
  blockedRate: number
  reasons: Record<string, number>
}

/** 形状守卫：离线回放面对真实事件文件中的脏行时降级跳过而非整体崩溃 */
function isPiHarnessToolResult(value: unknown): value is PiHarnessToolResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.name !== 'string') return false
  if (v.input !== undefined && (typeof v.input !== 'object' || v.input === null)) return false
  if (v.outcome !== undefined && v.outcome !== 'succeeded' && v.outcome !== 'failed') return false
  return true
}

export function replayPiHarnessCase(testCase: PiHarnessEvalCase): PiHarnessDecision | null {
  const harness = createPiHarness({ userPrompt: testCase.name })
  for (const tool of testCase.tools) {
    // 坏数据计入 skipped（由调用方统计），不抛 TypeError
    if (!isPiHarnessToolResult(tool)) return null
    harness.recordToolResult(tool)
  }
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
    // 与明细脱节的占位：若调用方跳过坏数据，需自行从 total 扣减后重新汇总
    skipped: 0,
    followUpRate: total === 0 ? 0 : count((decision) => decision.action === 'follow_up') / total,
    validatedRate: total === 0 ? 0 : count((decision) => decision.reason === 'validated') / total,
    blockedRate: total === 0 ? 0 : count((decision) => decision.reason === 'blocked_or_failed') / total,
    reasons,
  }
}

/** action × reason 交叉明细（统计口径单一来源，避免 followUpRate 按 action、validatedRate 按 reason 混轴） */
export function summarizePiHarnessMatrix(
  decisions: PiHarnessDecision[],
): { actionByReason: Record<string, Record<string, number>>; total: number } {
  const actionByReason: Record<string, Record<string, number>> = {}
  for (const decision of decisions) {
    const byAction = actionByReason[decision.reason] ?? {}
    byAction[decision.action] = (byAction[decision.action] ?? 0) + 1
    actionByReason[decision.reason] = byAction
  }
  return { actionByReason, total: decisions.length }
}
