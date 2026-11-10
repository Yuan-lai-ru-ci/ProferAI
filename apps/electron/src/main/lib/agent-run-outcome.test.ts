import { describe, expect, test } from 'bun:test'
import type { AgentSendInput } from '@profer/shared'
import { createAgentRunOutcomeReporter } from './agent-run-outcome'

type Outcome = Parameters<NonNullable<AgentSendInput['onRunOutcome']>>[0]

function fixture() {
  const outcomes: Outcome[] = []
  return { outcomes, reporter: createAgentRunOutcomeReporter(outcome => outcomes.push(outcome)) }
}

describe('Agent typed run outcome', () => {
  test('成功只在 finally 回传一次，后台 idle completion 不算终态', () => {
    const { outcomes, reporter } = fixture()
    reporter.onComplete({ backgroundTasksPending: true, resultSubtype: 'success' })
    expect(outcomes).toEqual([])
    reporter.onComplete({ resultSubtype: 'success' })
    expect(outcomes).toEqual([])
    reporter.finish()
    reporter.finish()
    expect(outcomes).toEqual([{ status: 'completed' }])
  })

  test('explicit completion status is authoritative over stale callbacks', () => {
    const { outcomes, reporter } = fixture()
    reporter.onError('stale provider error')
    reporter.onComplete({ outcomeStatus: 'completed', resultSubtype: 'delegation_cancelled' })
    reporter.finish()
    expect(outcomes).toEqual([{ status: 'completed' }])
  })

  test('first stop source is sticky across duplicate completion notifications', () => {
    const { outcomes, reporter } = fixture()
    reporter.onComplete({ outcomeStatus: 'stopped', stoppedByUser: true })
    reporter.onComplete({ outcomeStatus: 'stopped', stopReason: 'parent_cancel', stoppedByUser: false })
    reporter.finish()
    expect(outcomes).toEqual([{ status: 'stopped' }])
  })

  test('explicit failed status is authoritative even with success subtype', () => {
    const { outcomes, reporter } = fixture()
    reporter.onComplete({ outcomeStatus: 'failed', resultSubtype: 'success', resultErrors: ['ledger finish failed'] })
    reporter.finish()
    expect(outcomes).toEqual([{ status: 'failed', error: 'ledger finish failed' }])
  })

  test('异常、result subtype、resultErrors、endReason 均不能成为成功', () => {
    for (const options of [
      { resultSubtype: 'error_during_execution', resultErrors: ['provider failed'] },
      { resultSubtype: 'error_max_turns' },
      { resultSubtype: 'error_max_budget_usd' },
      { resultSubtype: 'max_tokens' },
      { resultSubtype: 'success', resultErrors: ['provider failed'] },
      { endReason: 'error' as const },
    ]) {
      const { outcomes, reporter } = fixture()
      reporter.onComplete(options)
      reporter.finish()
      expect(outcomes[0]?.status).toBe('failed')
      expect(outcomes[0]?.error).toBeTruthy()
    }
    const { outcomes, reporter } = fixture()
    reporter.onError('setup exception')
    reporter.finish()
    expect(outcomes).toEqual([{ status: 'failed', error: 'setup exception' }])
  })

  test('停止优先于早先的错误和迟到的异常', () => {
    const { outcomes, reporter } = fixture()
    reporter.onError('earlier failure')
    reporter.onComplete({ stoppedByUser: true, resultSubtype: 'error_during_execution' })
    reporter.onError('abort exception')
    reporter.finish()
    expect(outcomes).toEqual([{ status: 'stopped' }])
  })

  test('busy 拒绝不能回传任何 owner 终态', () => {
    const { outcomes, reporter } = fixture()
    reporter.rejectBeforeStart()
    reporter.finish()
    expect(outcomes).toEqual([])
  })

  test('无终态或只收到 background idle 不伪报成功', () => {
    const { outcomes, reporter } = fixture()
    reporter.onComplete({ backgroundTasksPending: true })
    reporter.finish()
    expect(outcomes[0]?.status).toBe('failed')
  })

  test('调用方 callback 抛错不能改变运行结果或重复回传', () => {
    let calls = 0
    const reporter = createAgentRunOutcomeReporter(() => { calls++; throw new Error('consumer error') })
    reporter.onComplete({ resultSubtype: 'success' })
    expect(() => reporter.finish()).not.toThrow()
    reporter.finish()
    expect(calls).toBe(1)
  })
})
