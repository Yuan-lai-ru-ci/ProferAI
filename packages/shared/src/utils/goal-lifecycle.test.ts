import { describe, expect, test } from 'bun:test'
import type { AgentGoalState } from '../types/agent'
import { applyGoalTransition, capGoalLifecycle, createGoalLifecycleEvent, getGoalActions, GOAL_LIFECYCLE_LIMIT, GOAL_STATUSES, isGoalTransitionAllowed, normalizeGoalReason } from './goal-lifecycle'

const goal = (patch: Partial<AgentGoalState> = {}): AgentGoalState => ({
  id: 'g', sessionId: 's', goal: '目标', status: 'active', revision: 1, iteration: 0,
  consecutiveFailures: 0, startedAt: 100, updatedAt: 100,
  limits: { maxIterations: 20, maxDurationMs: 1000, maxConsecutiveFailures: 3 }, ...patch,
})

describe('Goal 共享生命周期契约', () => {
  test('穷举状态转移：completed 只能 clear；stopping 不能 resume；相同状态不重复转移', () => {
    const allowed: Record<string, string[]> = {
      active: ['stopping', 'paused', 'completed', 'blocked', 'failed', 'stopped', 'budget_limited'],
      stopping: ['paused', 'stopped', 'budget_limited'],
      paused: ['active', 'stopped', 'budget_limited', 'cleared'],
      blocked: ['active', 'paused', 'stopped', 'budget_limited', 'cleared'],
      failed: ['active', 'paused', 'stopped', 'budget_limited', 'cleared'],
      stopped: ['active', 'paused', 'budget_limited', 'cleared'],
      budget_limited: ['active', 'paused', 'stopped', 'cleared'],
      completed: ['cleared'],
    }
    for (const from of GOAL_STATUSES) for (const to of [...GOAL_STATUSES, 'cleared'] as const) {
      expect(isGoalTransitionAllowed(from, to)).toBe(allowed[from]!.includes(to))
    }
    expect(isGoalTransitionAllowed(null, 'active')).toBe(true)
    expect(isGoalTransitionAllowed(null, 'cleared')).toBe(false)
  })

  test('owner 未释放时禁止编辑/恢复/清除，active 可发停止请求', () => {
    for (const status of GOAL_STATUSES) expect(getGoalActions(goal({ status, activeRunId: 'run' }))).toMatchObject({ canEdit: false, canResume: false, canClear: false })
    expect(getGoalActions(goal({ activeRunId: 'run' }))).toMatchObject({ canPause: true, canStop: true })
    expect(getGoalActions(goal({ status: 'stopping', activeRunId: 'run' }))).toMatchObject({ canPause: false, canStop: false })
  })

  test('预算按实际余量判断，budget_limited 编辑后可恢复，失败计数不阻止新重试窗口', () => {
    const exhausted = goal({ status: 'budget_limited', iteration: 20 })
    expect(getGoalActions(exhausted)).toMatchObject({ canResume: false, budgetEditRequired: true })
    expect(getGoalActions({ ...exhausted, limits: { ...exhausted.limits, maxIterations: 21 } })).toMatchObject({ canResume: true, budgetEditRequired: false })
    expect(getGoalActions(goal({ status: 'failed', consecutiveFailures: 3 })).canResume).toBe(true)
    expect(getGoalActions(goal({ status: 'completed' })).canResume).toBe(false)
  })

  test('结构化转移有稳定事件 ID、版本和运行归属，旧原因不从正文猜测', () => {
    const state = goal()
    const blocked = applyGoalTransition(state, 'blocked', { at: 200, detail: '需要凭据', runId: 'run' })
    expect(blocked).toMatchObject({ status: 'blocked', reasonCode: 'blocked', reasonDetail: '需要凭据', stopReason: '需要凭据', revision: 2 })
    expect(blocked.lifecycle?.[0]).toMatchObject({ id: 'g:2:blocked', from: 'active', to: 'blocked', revision: 2, runId: 'run', at: 200 })
    expect(applyGoalTransition(blocked, 'blocked', { at: 300 })).toBe(blocked)
    const resumed = applyGoalTransition(blocked, 'active', { at: 150 })
    expect(resumed).toMatchObject({ reasonCode: 'resumed', stopReason: undefined, updatedAt: 200 })
    expect(normalizeGoalReason('任意旧原因')).toBe('unknown')
    expect(normalizeGoalReason('需要输入', 'blocked')).toBe('blocked')
    expect(() => applyGoalTransition(goal({ status: 'completed' }), 'active', { at: 200 })).toThrow('非法')
  })

  test('clear 保留 stopped tombstone 和真实来源状态', () => {
    const cleared = applyGoalTransition(goal({ status: 'completed' }), 'cleared', { at: 200 })
    expect(cleared).toMatchObject({ status: 'stopped', reasonCode: 'cleared', stopReason: 'cleared' })
    expect(cleared.lifecycle?.at(-1)).toMatchObject({ from: 'completed', to: 'cleared' })
  })

  test('审计轨迹长度有界，并保留创建与最近终止事件', () => {
    const events = [createGoalLifecycleEvent({ goalId: 'g', sessionId: 's', from: null, to: 'active', reason: 'created', revision: 1, at: 100 })]
    events.push(createGoalLifecycleEvent({ goalId: 'g', sessionId: 's', from: 'active', to: 'stopped', reason: 'user_stop', revision: 2, at: 101 }))
    for (let revision = 3; revision <= 150; revision++) events.push(createGoalLifecycleEvent({ goalId: 'g', sessionId: 's', from: revision % 2 ? 'paused' : 'active', to: revision % 2 ? 'active' : 'paused', reason: 'user_pause', revision, at: 100 + revision }))
    const capped = capGoalLifecycle(events)
    expect(capped).toHaveLength(GOAL_LIFECYCLE_LIMIT)
    expect(capped[0]).toBe(events[0])
    expect(capped[1]).toBe(events[1])
    expect(capped.at(-1)).toBe(events.at(-1))
  })
})
