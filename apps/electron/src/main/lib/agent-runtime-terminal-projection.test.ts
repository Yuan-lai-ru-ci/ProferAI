/**
 * agent-runtime-terminal-projection 单测
 *
 * 覆盖：终态字段映射（含 outcome 丢失字段的恢复）、`run_completed` 单一映射、
 * 一次性闸门（onError/onComplete 各最多一次、顺序固定、迟到终态被忽略）。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { resolveDelegationTerminalStatus } from './agent-collaboration-utils'
import {
  buildRunCompletedProjection,
  createRuntimeTerminalProjector,
  readResultSignal,
  resolveRuntimeTerminalFields,
  type RuntimeTerminalFields,
} from './agent-runtime-terminal-projection'

const resultMessage = (subtype?: string, errors?: string[]) => ({
  type: 'result',
  ...(subtype !== undefined ? { subtype } : {}),
  ...(errors !== undefined ? { errors } : {}),
}) as unknown as SDKMessage

describe('readResultSignal', () => {
  test('只保留非空 subtype 与去空白后的非空 errors', () => {
    expect(readResultSignal(undefined)).toEqual({})
    expect(readResultSignal(resultMessage('success', ['a', '  ', 'b']))).toEqual({ subtype: 'success', errors: ['a', 'b'] })
    expect(readResultSignal(resultMessage('', []))).toEqual({})
  })
})

describe('resolveRuntimeTerminalFields', () => {
  test('completed：透传 startedAt / resultSubtype，endReason=completed', () => {
    const fields = resolveRuntimeTerminalFields({
      outcome: { status: 'completed' },
      observation: { startedAt: 1000, resultMessage: resultMessage('success') },
    })
    expect(fields).toEqual({
      outcomeStatus: 'completed',
      stoppedByUser: false,
      startedAt: 1000,
      resultSubtype: 'success',
      endReason: 'completed',
      endReasonLabel: '',
    })
  })

  test('failed：从 result 消息恢复 resultSubtype/resultErrors（outcome 已丢失）', () => {
    const fields = resolveRuntimeTerminalFields({
      outcome: { status: 'failed', error: 'boom' },
      observation: { startedAt: 2000, resultMessage: resultMessage('error_during_execution', ['boom-a', 'boom-b']) },
    })
    expect(fields).toEqual({
      outcomeStatus: 'failed',
      stoppedByUser: false,
      startedAt: 2000,
      resultSubtype: 'error_during_execution',
      resultErrors: ['boom-a', 'boom-b'],
      endReason: 'error',
      endReasonLabel: '执行出错',
    })
  })

  test('failed 且没有 result 消息：resultErrors 回落 outcome.error（移动端一定有可读原因）', () => {
    const fields = resolveRuntimeTerminalFields({
      outcome: { status: 'failed', error: 'Credential resolution failed: token_expired' },
      observation: { startedAt: 1 },
    })
    expect(fields.resultErrors).toEqual(['Credential resolution failed: token_expired'])
    expect(fields.resultSubtype).toBeUndefined()
    expect(fields.endReason).toBe('error')
    expect(fields.endReasonLabel).toBe('执行出错')
  })

  test('stopped（用户停止）：stoppedByUser=true、endReason=stopped_by_user', () => {
    const fields = resolveRuntimeTerminalFields({
      outcome: { status: 'stopped' },
      source: 'bridge',
      observation: { startedAt: 5 },
    })
    expect(fields.stoppedByUser).toBe(true)
    expect(fields.endReason).toBe('stopped_by_user')
    expect(fields.resultSubtype).toBeUndefined()
  })

  test('stopped（委派取消）：trusted stopReason creates cancellation label without forging subtype', () => {
    const fields = resolveRuntimeTerminalFields({
      outcome: { status: 'stopped', stopReason: 'parent_cancel' },
      source: 'delegation',
      observation: { startedAt: 5 },
    })
    expect(fields).toEqual({ outcomeStatus: 'stopped', stopReason: 'parent_cancel', stoppedByUser: false, startedAt: 5, endReason: 'unknown', endReasonLabel: '协作子任务已取消' })
    expect(fields.resultSubtype).toBeUndefined()
  })

  test('用户单停委派 child 与来源无关：只能是 interrupted，不能冒称父取消', () => {
    const fields = resolveRuntimeTerminalFields({ source: 'delegation', outcome: { status: 'stopped' } })
    expect(fields.stoppedByUser).toBe(true)
    expect(fields.resultSubtype).toBeUndefined()
    expect(fields.endReason).toBe('stopped_by_user')
  })

  test('completed run carrying the historical cancellation sentinel stays completed and preserves subtype', () => {
    const fields = resolveRuntimeTerminalFields({
      source: 'delegation',
      outcome: { status: 'completed' },
      observation: { resultMessage: resultMessage('delegation_cancelled') },
    })
    expect(fields).toMatchObject({ outcomeStatus: 'completed', resultSubtype: 'delegation_cancelled', endReason: 'completed' })
  })

  test('subtype sentinel alone is not cancellation; explicit stopped status plus trusted stop reason is', () => {
    const result = (subtype: string) => ({ type: 'result', subtype }) as unknown as SDKMessage
    const completed = resolveRuntimeTerminalFields({ outcome: { status: 'completed' }, observation: { resultMessage: result('delegation_cancelled') } })
    const stopped = resolveRuntimeTerminalFields({ outcome: { status: 'stopped', stopReason: 'parent_cancel' } })
    expect(resolveDelegationTerminalStatus(completed)).toBe('completed')
    expect(resolveDelegationTerminalStatus(stopped)).toBe('cancelled')
  })

  test('delegation 来源不把正常完成改写为取消', () => {
    const fields = resolveRuntimeTerminalFields({
      source: 'delegation',
      outcome: { status: 'completed' },
      observation: { resultMessage: resultMessage('success') },
    })
    expect(fields).toMatchObject({
      stoppedByUser: false,
      resultSubtype: 'success',
      endReason: 'completed',
    })
    expect(fields.resultSubtype).not.toBe('delegation_cancelled')
  })

  test('delegation 来源不覆盖失败结果', () => {
    const fields = resolveRuntimeTerminalFields({
      source: 'delegation',
      outcome: { status: 'failed', error: 'provider failed' },
      observation: { resultMessage: resultMessage('error_during_execution', ['provider failed']) },
    })
    expect(fields).toMatchObject({
      stoppedByUser: false,
      resultSubtype: 'error_during_execution',
      endReason: 'error',
    })
  })

  test('最终 failed outcome 不被旧 success result 消息覆盖', () => {
    const fields = resolveRuntimeTerminalFields({
      outcome: { status: 'failed', error: 'ledger write failed after provider success' },
      observation: { resultMessage: resultMessage('success') },
    })
    expect(fields).toMatchObject({
      stoppedByUser: false,
      resultSubtype: 'success',
      resultErrors: ['ledger write failed after provider success'],
      endReason: 'error',
    })
  })

  test('backgroundTasksPending 只在显式为 true 时出现', () => {
    expect(
      resolveRuntimeTerminalFields({ outcome: { status: 'completed' }, observation: { backgroundTasksPending: true } })
        .backgroundTasksPending,
    ).toBe(true)
    expect(
      resolveRuntimeTerminalFields({ outcome: { status: 'completed' }, observation: {} }).backgroundTasksPending,
    ).toBeUndefined()
  })
})

describe('buildRunCompletedProjection', () => {
  test('终态字段完整映射，且不含 undefined 键（避免字段集漂移）', () => {
    const fields: RuntimeTerminalFields = {
      stoppedByUser: false,
      startedAt: 42,
      resultSubtype: 'error_during_execution',
      resultErrors: ['boom'],
      backgroundTasksPending: true,
      endReason: 'error',
      endReasonLabel: '执行出错',
    }
    const projection = buildRunCompletedProjection('s-1', fields)
    expect(projection).toEqual({
      type: 'run_completed',
      sessionId: 's-1',
      stoppedByUser: false,
      startedAt: 42,
      resultSubtype: 'error_during_execution',
      resultErrors: ['boom'],
      backgroundTasksPending: true,
      endReason: 'error',
      endReasonLabel: '执行出错',
    })
    expect(Object.values(projection).filter(value => value === undefined)).toEqual([])
  })

  test('缺省字段不产生空键（与旧 remote 分支 `opts?.x` 语义一致）', () => {
    expect(buildRunCompletedProjection('s-2', { stoppedByUser: true })).toEqual({
      type: 'run_completed',
      sessionId: 's-2',
      stoppedByUser: true,
    })
  })
})

describe('createRuntimeTerminalProjector', () => {
  const sink = () => {
    const calls: string[] = []
    const completions: RuntimeTerminalFields[] = []
    return {
      calls,
      completions,
      sink: {
        onError: (error: string) => calls.push(`error:${error}`),
        onComplete: (fields: RuntimeTerminalFields) => {
          calls.push(`complete:${fields.endReason ?? 'none'}`)
          completions.push(fields)
        },
      },
    }
  }

  test('失败：onError 先于 onComplete，且各自只一次', () => {
    const s = sink()
    const projector = createRuntimeTerminalProjector({ sink: s.sink, source: 'bridge' })
    projector.observeRunStarted(7)
    projector.observeProviderError(new Error('provider boom'))
    const settlement = projector.settle({ status: 'failed', error: 'outcome boom' })
    expect(settlement.delivered).toBe(true)
    // provider 报错优先于 outcome 文案（旧路径 onError 拿到的是 provider 原文）
    expect(s.calls).toEqual(['error:provider boom', 'complete:error'])
    expect(s.completions[0]?.startedAt).toBe(7)
    expect(s.completions[0]?.endReasonLabel).toBe('执行出错')
  })

  test('重复 / 迟到的终态不再投递（终态一次性）', () => {
    const s = sink()
    const projector = createRuntimeTerminalProjector({ sink: s.sink })
    projector.settle({ status: 'completed' })
    expect(projector.settle({ status: 'failed', error: 'late' }).delivered).toBe(false)
    projector.observeProviderError(new Error('after terminal'))
    projector.observeRunStarted(99)
    expect(s.calls).toEqual(['complete:completed'])
    expect(projector.settled).toBe(true)
  })

  test('用户停止优先于期间出现的 provider 错误：不投递 onError', () => {
    const s = sink()
    const projector = createRuntimeTerminalProjector({ sink: s.sink })
    projector.observeProviderError('interrupted by user')
    projector.settle({ status: 'stopped' })
    expect(s.calls).toEqual(['complete:stopped_by_user'])
  })

  test('rejectBeforeStart：并发拒绝 / 内核不匹配时不广播任何终态', () => {
    const s = sink()
    const projector = createRuntimeTerminalProjector({ sink: s.sink })
    projector.rejectBeforeStart()
    expect(projector.settle({ status: 'failed', error: 'Agent session is already running' }).delivered).toBe(false)
    expect(s.calls).toEqual([])
  })

  test('轻量完成独立投递：软空闲带 backgroundTasksPending，真终态保持干净', () => {
    const s = sink()
    const projector = createRuntimeTerminalProjector({ sink: s.sink, source: 'automation' })
    projector.observeRunStarted(11)
    projector.observeMessage({ type: 'assistant' } as unknown as SDKMessage)
    projector.observeMessage(resultMessage('error_during_execution', ['stream boom']))
    // 软空闲：独立投递、不算终态（与旧编排层 `idleComplete` 同义）。
    expect(projector.settleBackgroundTasksPending({ startedAt: 11, resultSubtype: 'success' })).toMatchObject({
      backgroundTasksPending: true,
      startedAt: 11,
      resultSubtype: 'success',
    })
    expect(projector.settled).toBe(false)
    projector.settle({ status: 'failed', error: 'outcome boom' })
    expect(s.completions[0]).toMatchObject({ backgroundTasksPending: true, startedAt: 11, resultSubtype: 'success' })
    // 真终态从 result 消息恢复 subtype/errors，且**不**携带 backgroundTasksPending。
    expect(s.completions[1]).toMatchObject({
      startedAt: 11,
      resultSubtype: 'error_during_execution',
      resultErrors: ['stream boom'],
      endReason: 'error',
    })
    expect(s.completions[1]?.backgroundTasksPending).toBeUndefined()
  })

  test('终态消息载荷由调用方提供（旧 onComplete(messages, opts) 第一参语义）', () => {
    const s = sink()
    const messages = [{ role: 'assistant' }] as never
    const projector = createRuntimeTerminalProjector({ sink: s.sink, messages: () => messages })
    const seen: unknown[] = []
    const projector2 = createRuntimeTerminalProjector({
      sink: { onError: () => {}, onComplete: (_fields, passed) => seen.push(passed) },
      messages: () => messages,
    })
    projector.settle({ status: 'completed' })
    projector2.settle({ status: 'completed' })
    expect(seen[0]).toBe(messages)
  })
})
