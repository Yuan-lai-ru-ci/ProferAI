import { describe, expect, test } from 'bun:test'
import { prependPiCompactionTaskGuidance } from '@profer/shared'
import { PI_COMPACTION_CONTINUATION_PROMPT, planPiCompactionContinuation } from '../pi-agent-adapter'

describe('Pi task guidance for compaction continuation', () => {
  const browserGuidance = '## Profer 受管浏览器\n必须按授权根目录操作。'

  test('CompactContext continuation places the current task guidance before the generic handoff', () => {
    const plan = planPiCompactionContinuation({
      continuationCount: 0, abortRequested: false, runtimeLimitReached: false, taskPrompt: browserGuidance,
    })
    expect(plan.shouldContinue).toBe(true)
    if (!plan.shouldContinue) return
    expect(plan.prompt).toBe(prependPiCompactionTaskGuidance(PI_COMPACTION_CONTINUATION_PROMPT, browserGuidance))
    expect(plan.prompt.indexOf(browserGuidance)).toBeLessThan(plan.prompt.indexOf('<profer_compaction_continuation>'))
  })

  test('No task guidance leaves the original continuation prompt unchanged', () => {
    const plan = planPiCompactionContinuation({ continuationCount: 0, abortRequested: false, runtimeLimitReached: false })
    expect(plan.shouldContinue).toBe(true)
    if (plan.shouldContinue) expect(plan.prompt).toBe(PI_COMPACTION_CONTINUATION_PROMPT)
  })

  test('Abort, runtime limits, and continuation limits still prevent automatic continuation', () => {
    expect(planPiCompactionContinuation({ continuationCount: 0, abortRequested: true, runtimeLimitReached: false, taskPrompt: browserGuidance }))
      .toEqual({ shouldContinue: false, reason: 'aborted' })
    expect(planPiCompactionContinuation({ continuationCount: 0, abortRequested: false, runtimeLimitReached: true, taskPrompt: browserGuidance }))
      .toEqual({ shouldContinue: false, reason: 'runtime_limit' })
    expect(planPiCompactionContinuation({ continuationCount: 20, abortRequested: false, runtimeLimitReached: false, taskPrompt: browserGuidance }))
      .toEqual({ shouldContinue: false, reason: 'continuation_limit' })
  })
})
