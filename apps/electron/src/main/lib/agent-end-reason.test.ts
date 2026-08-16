/**
 * agent-end-reason 测试 — 结束原因归一化全分支覆盖
 *
 * 对应 design.md 4.1 单元测试表：覆盖 stopped_by_user / completed / max_turns /
 * max_budget / max_tokens / error / unknown / 防御性兜底 / label 一致性。
 */
import { describe, test, expect } from 'bun:test'
import { normalizeAgentEndReason, AGENT_END_REASON_LABELS } from './agent-end-reason'
import type { NormalizeAgentEndReasonInput } from './agent-end-reason'
import type { AgentEndReason } from '@profer/shared'

describe('normalizeAgentEndReason', () => {
  test('用户停止优先于一切（即使 resultSubtype=success）', () => {
    const result = normalizeAgentEndReason({ stoppedByUser: true, resultSubtype: 'success' })
    expect(result.reason).toBe('stopped_by_user')
    expect(result.label).toBe('已被用户中断')
  })

  test('正常完成（resultSubtype=success）→ completed', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'success' })
    expect(result.reason).toBe('completed')
  })

  test('Pi 长度截断（max_tokens）→ max_tokens', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'max_tokens' })
    expect(result.reason).toBe('max_tokens')
    expect(result.label).toBe('已中断：达到长度上限')
  })

  test('Claude 轮次上限（error_max_turns）→ max_turns', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'error_max_turns' })
    expect(result.reason).toBe('max_turns')
    expect(result.label).toBe('已中断：达到轮次上限')
  })

  test('预算上限（error_max_budget_usd）→ max_budget', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'error_max_budget_usd' })
    expect(result.reason).toBe('max_budget')
    expect(result.label).toBe('已中断：达到预算上限')
  })

  test('执行期错误（error_during_execution）→ error', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'error_during_execution' })
    expect(result.reason).toBe('error')
    expect(result.label).toBe('执行出错')
  })

  test('preflight/异常（无 subtype，hasError）→ error', () => {
    const result = normalizeAgentEndReason({ hasError: true })
    expect(result.reason).toBe('error')
  })

  test('hasError 与已知 subtype 冲突时 subtype 优先（error_max_turns > hasError）', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'error_max_turns', hasError: true })
    expect(result.reason).toBe('max_turns')
  })

  test('未知 subtype → unknown', () => {
    const result = normalizeAgentEndReason({ resultSubtype: 'some_future_subtype' })
    expect(result.reason).toBe('unknown')
    expect(result.label).toBe('任务中断')
  })

  test('干净结束无 subtype（防御）→ completed，不误判为中断', () => {
    const result = normalizeAgentEndReason({})
    expect(result.reason).toBe('completed')
  })

  test('干净结束但带空字符串 subtype（防御）→ completed', () => {
    const result = normalizeAgentEndReason({ resultSubtype: '' })
    expect(result.reason).toBe('completed')
  })
})

describe('AGENT_END_REASON_LABELS 一致性', () => {
  const reasons: AgentEndReason[] = [
    'completed',
    'stopped_by_user',
    'max_turns',
    'max_budget',
    'max_tokens',
    'error',
    'unknown',
  ]

  test('label 表覆盖全部枚举值', () => {
    for (const reason of reasons) {
      expect(AGENT_END_REASON_LABELS[reason]).toBeTypeOf('string')
    }
  })

  test('completed 的 label 为空串（正常完成不记录/不显示）', () => {
    expect(AGENT_END_REASON_LABELS.completed).toBe('')
  })

  test('非 completed 的 label 均非空', () => {
    for (const reason of reasons.filter((r) => r !== 'completed')) {
      expect(AGENT_END_REASON_LABELS[reason].length).toBeGreaterThan(0)
    }
  })

  test('归一化输出的 label 与 label 表一致', () => {
    const cases: Array<[NormalizeAgentEndReasonInput, AgentEndReason]> = [
      [{ stoppedByUser: true }, 'stopped_by_user'],
      [{ resultSubtype: 'success' }, 'completed'],
      [{ resultSubtype: 'max_tokens' }, 'max_tokens'],
      [{ resultSubtype: 'error_max_turns' }, 'max_turns'],
      [{ resultSubtype: 'error_max_budget_usd' }, 'max_budget'],
      [{ resultSubtype: 'error_during_execution' }, 'error'],
      [{ hasError: true }, 'error'],
      [{ resultSubtype: 'future_unknown' }, 'unknown'],
      [{}, 'completed'],
    ]
    for (const [input, expected] of cases) {
      const result = normalizeAgentEndReason(input)
      expect(result.reason).toBe(expected)
      expect(result.label).toBe(AGENT_END_REASON_LABELS[expected])
    }
  })
})
