import { describe, expect, test } from 'bun:test'
import { createAgentRunOutcomeReporter } from './outcome'

describe('Agent run outcome', () => {
  test('Given a successful completion Then it reports completed once', () => {
    const outcomes: unknown[] = []
    const reporter = createAgentRunOutcomeReporter((outcome) => outcomes.push(outcome))
    reporter.onComplete({ resultSubtype: 'success' })
    expect(reporter.finish()).toEqual({ status: 'completed' })
    expect(reporter.finish()).toEqual({ status: 'completed' })
    expect(outcomes).toEqual([{ status: 'completed' }])
  })

  test('Given an error and a failed result Then it preserves the first useful error', () => {
    const reporter = createAgentRunOutcomeReporter()
    reporter.onError('network failed')
    reporter.onComplete({ resultSubtype: 'error_during_execution', resultErrors: ['provider failed'] })
    expect(reporter.finish()).toEqual({ status: 'failed', error: 'network failed' })
  })

  test('Given a stop signal Then it wins over a provider error and retains trusted stop reason', () => {
    const reporter = createAgentRunOutcomeReporter()
    reporter.onError('late error')
    reporter.onComplete({ outcomeStatus: 'stopped', stopReason: 'parent_cancel', stoppedByUser: false, resultSubtype: 'success' })
    expect(reporter.finish()).toEqual({ status: 'stopped', stopReason: 'parent_cancel' })
  })

  test('first stop source is sticky when a later callback adds a different source', () => {
    const reporter = createAgentRunOutcomeReporter()
    reporter.onComplete({ outcomeStatus: 'stopped', stoppedByUser: true })
    reporter.onComplete({ outcomeStatus: 'stopped', stopReason: 'parent_cancel', stoppedByUser: false })
    expect(reporter.finish()).toEqual({ status: 'stopped' })
  })

  test('Given completed status with the historical cancellation sentinel Then it remains completed', () => {
    const reporter = createAgentRunOutcomeReporter()
    reporter.onComplete({ outcomeStatus: 'completed', resultSubtype: 'delegation_cancelled' })
    expect(reporter.finish()).toEqual({ status: 'completed' })
  })

  test('Given a background task pending signal Then completion remains open', () => {
    const reporter = createAgentRunOutcomeReporter()
    reporter.onComplete({ backgroundTasksPending: true })
    expect(reporter.finish()).toEqual({ status: 'failed', error: 'Agent 未产生运行终态' })
  })

  test('Given rejection before ownership Then finish does not notify the observer', () => {
    const outcomes: unknown[] = []
    const reporter = createAgentRunOutcomeReporter((outcome) => outcomes.push(outcome))
    reporter.rejectBeforeStart()
    expect(reporter.finish()).toBeUndefined()
    expect(outcomes).toEqual([])
  })
})
