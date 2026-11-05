import { describe, expect, test } from 'bun:test'
import type { AgentGoalState } from '@profer/shared'
import { formatGoalBudget, formatGoalElapsed, getGoalElapsed, getGoalStatusLabel, getGoalTerminalNotification, isGoalLive, isGoalRunning, needsGoalAttention, summarizeGoalRailCounts } from './goal-display-policy'

const goal = (patch: Partial<AgentGoalState> = {}): AgentGoalState => ({
  id: 'goal', sessionId: 'session', goal: '目标', status: 'active', revision: 1, iteration: 2,
  consecutiveFailures: 0, startedAt: 100, updatedAt: 1_000, elapsedMs: 4_000,
  limits: { maxConsecutiveFailures: 3 }, ...patch,
})

describe('Goal 显示 domain', () => {
  test('只有明确 owner 的 active/stopping 才计入实时运行时长', () => {
    expect(isGoalRunning(goal())).toBe(false)
    expect(isGoalRunning(goal({ activeRunId: 'run' }))).toBe(true)
    expect(isGoalRunning(goal({ status: 'stopping', activeRunId: 'run' }))).toBe(true)
    expect(isGoalRunning(goal({ status: 'paused', activeRunId: 'run' }))).toBe(false)
    expect(getGoalElapsed(goal({ activeRunId: 'run' }), 2_500)).toBe(5_500)
  })

  test('状态文案区分审批、计划、重试和可发消息续跑', () => {
    expect(getGoalStatusLabel(goal({ activeRunId: 'run' }), { askUser: 1, permission: 0 }, 2_000)).toBe('等待你的回答')
    expect(getGoalStatusLabel(goal({ waiting: 'plan_mode' }), { askUser: 0, permission: 0 }, 2_000)).toContain('计划模式')
    expect(getGoalStatusLabel(goal({ retry: { attempt: 2, nextAt: 3_000, error: '网络' } }), { askUser: 0, permission: 0 }, 2_000)).toContain('第 2 次重试')
    expect(getGoalStatusLabel(goal({ status: 'blocked' }), { askUser: 0, permission: 0 }, 2_000)).toContain('发消息补充后自动继续')
    // 空闲自检：倒计时 / 达到上限后提示发消息即可继续
    expect(getGoalStatusLabel(goal({ idleCheckin: { count: 0, nextAt: 62_000 } }), { askUser: 0, permission: 0 }, 2_000)).toBe('空闲中，1m后自动继续')
    expect(getGoalStatusLabel(goal({ idleCheckin: { count: 2, nextAt: 62_000 } }), { askUser: 0, permission: 0 }, 2_000)).toContain('第 3 次')
    expect(getGoalStatusLabel(goal({ idleCheckin: { count: 3, paused: true } }), { askUser: 0, permission: 0 }, 2_000)).toBe('空闲自检已暂停 · 发消息即可继续')
  })

  test('完成/受阻/失败/预算耗尽/需要人处理的暂停才主动通知，用户主动暂停与清除不打扰', () => {
    expect(getGoalTerminalNotification(goal({ status: 'completed', lastSummary: '测试通过' }))).toEqual({ title: 'Goal 已完成', body: '测试通过' })
    expect(getGoalTerminalNotification(goal({ status: 'blocked', stopReason: '需要密钥' }))?.title).toBe('Goal 受阻，等待你的输入')
    expect(getGoalTerminalNotification(goal({ status: 'budget_limited' }))?.title).toBe('Goal 预算已耗尽')
    expect(getGoalTerminalNotification(goal({ status: 'failed', reasonCode: 'failed' }))?.title).toBe('Goal 执行失败')
    // 运行错误重试用尽后状态是 paused，不是 failed：最需要用户处理的情况必须通知
    expect(getGoalTerminalNotification(goal({ status: 'paused', reasonCode: 'retry_exhausted', lastSummary: '网络错误' }))).toEqual({ title: 'Goal 已暂停，需要你处理', body: '网络错误' })
    expect(getGoalTerminalNotification(goal({ status: 'paused', reasonCode: 'run_error' }))?.title).toBe('Goal 已暂停，需要你处理')
    expect(getGoalTerminalNotification(goal({ status: 'active' }))).toBeNull()
    expect(getGoalTerminalNotification(goal({ status: 'paused', reasonCode: 'user_pause' }))).toBeNull()
    expect(getGoalTerminalNotification(goal({ status: 'paused', reasonCode: 'user_interrupt' }))).toBeNull()
    expect(getGoalTerminalNotification(goal({ status: 'stopped', reasonCode: 'cleared', stopReason: 'cleared' }))).toBeNull()
    expect(getGoalTerminalNotification(goal({ status: 'stopped', reasonCode: 'user_stop' }))).toBeNull()
  })

  test('预算和时长格式保持稳定且不受组件依赖', () => {
    expect(formatGoalElapsed(65_000)).toBe('1m5s')
    expect(formatGoalBudget({ maxIterations: 3, maxDurationMs: 120_000, maxConsecutiveFailures: 2 })).toContain('3 轮 · 2m')
    expect(formatGoalBudget({ maxConsecutiveFailures: 2 })).toContain('不限')
  })
})

describe('Goal 侧栏计数口径', () => {
  test('暂停、受阻、预算耗尽都还没结束，都算 live', () => {
    const counts = summarizeGoalRailCounts([
      { status: 'active' },
      { status: 'paused' },
      { status: 'blocked' },
      { status: 'budget_limited' },
      { status: 'completed' },
      { status: 'stopped' },
      { status: 'failed' },
    ])
    expect(counts.live).toBe(4)
  })

  test('只有真正在跑的算 running，暂停不算「进行中」', () => {
    expect(summarizeGoalRailCounts([{ status: 'active' }, { status: 'stopping' }, { status: 'paused' }])).toEqual({ live: 3, running: 2, attention: 0 })
  })

  test('角标只在受阻或预算耗尽时亮：正在跑的目标不需要用户管', () => {
    expect(needsGoalAttention({ status: 'active' })).toBe(false)
    expect(needsGoalAttention({ status: 'paused' })).toBe(false)
    expect(needsGoalAttention({ status: 'blocked' })).toBe(true)
    expect(needsGoalAttention({ status: 'budget_limited' })).toBe(true)
    expect(summarizeGoalRailCounts([{ status: 'active' }, { status: 'blocked' }]).attention).toBe(1)
  })

  test('没有 Goal 时三项计数都是 0（入口不显示数字）', () => {
    expect(summarizeGoalRailCounts([])).toEqual({ live: 0, running: 0, attention: 0 })
  })
})
