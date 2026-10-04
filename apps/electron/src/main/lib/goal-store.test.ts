import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GOAL_LIFECYCLE_LIMIT, createGoalLifecycleEvent } from '@profer/shared'
import type { AgentGoalLifecycleEvent, AgentGoalReasonCode, AgentGoalState, AgentGoalStatus } from '@profer/shared'
import { archiveGoalState, loadGoalHistory, loadGoalStates, saveGoalStates } from './goal-store'
import { createGoalState, DEFAULT_GOAL_LIMITS } from './goal-loop'

function lifecycleGoal(): AgentGoalState & { lifecycle: AgentGoalLifecycleEvent[] } {
  const goal = createGoalState('session-audit', '可审计目标', 1000)
  return {
    ...goal, status: 'paused', revision: 3, updatedAt: 1100,
    reasonCode: 'user_pause', reasonDetail: '用户暂时暂停',
    lifecycle: [
      createGoalLifecycleEvent({ goalId: goal.id, sessionId: goal.sessionId, from: null, to: 'active', reason: 'created', revision: 1, at: 1000 }),
      createGoalLifecycleEvent({ goalId: goal.id, sessionId: goal.sessionId, from: 'active', to: 'paused', reason: 'user_pause', detail: '用户暂时暂停', revision: 3, at: 1100, runId: 'run-1' }),
    ],
  }
}

function invalidLifecycles(goal: ReturnType<typeof lifecycleGoal>): unknown[] {
  const [created, paused] = goal.lifecycle
  return [
    null, {}, [null], [{}],
    ...[
      { id: '' }, { id: ' ' }, { id: 123 }, { id: undefined },
      { goalId: 'other-goal' }, { goalId: undefined },
      { sessionId: 'other-session' }, { sessionId: undefined },
      { from: 'cleared' }, { from: undefined }, { from: ['active'] },
      { to: 'unknown-status' }, { to: null }, { to: ['paused'] },
      { from: null }, { from: 'completed' }, { from: 'paused' },
      { from: 'active', to: 'cleared' }, { from: 'stopping', to: 'failed' },
      { reason: 'user' }, { reason: undefined }, { reason: ['user_pause'] },
      { revision: -1 }, { revision: 1.5 }, { revision: '3' },
      { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: undefined },
      { revision: 4 }, { at: -1 }, { at: 1.5 }, { at: '1100' },
      { at: Number.MAX_SAFE_INTEGER + 1 }, { at: undefined },
      { runId: 1 }, { runId: null }, { detail: {} }, { detail: null },
    ].map((patch) => [{ ...paused, ...patch }]),
    [created, { ...paused, id: created?.id }],
    [created, { ...paused, revision: 1 }],
    [paused, created],
  ]
}

describe('goal store', () => {
  test('round-trips goal states', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('session-1', '完成登录页', 1000, DEFAULT_GOAL_LIMITS, { verification: '测试通过' })
      saveGoalStates(file, [{ ...goal, status: 'paused' }])
      const loaded = loadGoalStates(file)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject({ sessionId: 'session-1', goal: '完成登录页', status: 'paused', contract: { verification: '测试通过' }, history: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns empty list for missing or corrupt files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      expect(loadGoalStates(join(dir, 'missing.json'))).toEqual([])
      const corrupt = join(dir, 'corrupt.json')
      writeFileSync(corrupt, '{not json', 'utf8')
      expect(loadGoalStates(corrupt)).toEqual([])
      const invalid = join(dir, 'invalid.json')
      writeFileSync(invalid, JSON.stringify({ goals: [{ foo: 1 }] }), 'utf8')
      expect(loadGoalStates(invalid)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('strictly validates schema and version while accepting old v1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('s', '目标', 1000)
      writeFileSync(file, JSON.stringify({ version: 1, goals: [goal, { ...goal, id: 'bad', limits: { ...goal.limits, maxIterations: -1 } }, { ...goal, id: 'bad2', status: 'arbitrary' }, { ...goal, id: 'bad3', iteration: '20' }, { ...goal, id: 'bad4', usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } }] }))
      expect(loadGoalStates(file).map((state) => state.id)).toEqual([goal.id])
      writeFileSync(file, JSON.stringify({ version: 99, goals: [goal] }))
      expect(loadGoalStates(file)).toEqual([])
      writeFileSync(file, JSON.stringify({ goals: [goal] }))
      expect(loadGoalStates(file)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('archives by goalId idempotently and live save preserves archives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const old = { ...createGoalState('s', '旧目标', 1000), status: 'blocked' as const }
      saveGoalStates(file, [old])
      archiveGoalState(file, old)
      archiveGoalState(file, old)
      const next = createGoalState('s', '新目标', 2000)
      saveGoalStates(file, [next])
      expect(loadGoalStates(file).map((state) => state.id)).toEqual([next.id])
      expect(loadGoalHistory(file, 's').map((state) => state.id)).toEqual([old.id])
      expect(loadGoalHistory(file, 'other')).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('严格拒绝坏 history、contract、owner 和非有限预算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('s', '目标', 1000)
      const bad = [
        { ...goal, id: '', },
        { ...goal, contract: { verification: 123 } },
        { ...goal, activeRunId: {} },
        { ...goal, history: [{ iteration: 1 }] },
        { ...goal, history: [{ iteration: 1, startedAt: 1, finishedAt: 2, status: 'wrong', summary: 'x', evidence: [] }] },
        { ...goal, lastEvidence: [123] },
      ]
      writeFileSync(file, JSON.stringify({ version: 2, goals: bad }))
      expect(loadGoalStates(file)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('v1 elapsedMs 从已存执行记录迁移，不能包括暂停时间', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const { elapsedMs: _elapsed, revision: _revision, ...goal } = createGoalState('s', '目标', 1000)
      writeFileSync(file, JSON.stringify({ version: 1, goals: [{ ...goal, history: [{ iteration: 1, startedAt: 1000, finishedAt: 1050, status: 'continue', summary: '进展', evidence: ['证据'] }], updatedAt: 10000000 }] }))
      expect(loadGoalStates(file)[0]?.elapsedMs).toBe(50)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('save 非法状态不覆盖原子文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('s', '目标', 1000)
      saveGoalStates(file, [goal])
      expect(() => saveGoalStates(file, [{ ...goal, limits: { ...goal.limits, maxDurationMs: NaN } }])).toThrow()
      expect(loadGoalStates(file)[0]?.id).toBe(goal.id)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('损坏或未知版本文件不能被恢复保存覆盖，归档不按全局20条丢历史', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      writeFileSync(file, '{broken')
      expect(() => saveGoalStates(file, [])).toThrow('已保留原文件')
      expect(readFileSync(file, 'utf8')).toBe('{broken')
      writeFileSync(file, JSON.stringify({ version: 999, goals: [] }))
      expect(() => archiveGoalState(file, createGoalState('s', '目标'))).toThrow()
      writeFileSync(file, JSON.stringify({ version: 2, goals: [], history: [] }))
      for (let i = 0; i < 25; i++) archiveGoalState(file, createGoalState('s', `目标${i}`))
      expect(loadGoalHistory(file, 's')).toHaveLength(25)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test.each([1, 2, 3])('schema %i 缺新字段时只补默认值，不生成旧事件或执行重启转移', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const { lifecycle: _lifecycle, reasonCode: _reasonCode, reasonDetail: _reasonDetail, revision: _revision, ...legacy } = lifecycleGoal()
      const goal = { ...legacy, status: 'active', activeRunId: 'old-run' }
      writeFileSync(file, JSON.stringify({ version, goals: [goal], history: [goal] }))
      const original = readFileSync(file, 'utf8')
      const loaded = loadGoalStates(file)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject({ status: 'active', activeRunId: 'old-run', revision: 1, lifecycle: [], reasonCode: 'unknown' })
      expect(loadGoalHistory(file)).toEqual(loaded)
      expect(readFileSync(file, 'utf8')).toBe(original)
      saveGoalStates(file, loaded)
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(3)
      expect(loadGoalStates(file)).toEqual(loaded)
      expect(loadGoalHistory(file)).toEqual(loaded)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('旧原因按状态兜底并归一化，同时保留明确的 reasonDetail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const { lifecycle: _lifecycle, reasonCode: _reasonCode, reasonDetail: _reasonDetail, ...legacy } = lifecycleGoal()
      const cases: Array<{ status: AgentGoalStatus; stopReason?: string; reasonCode: AgentGoalReasonCode }> = [
        { status: 'active', reasonCode: 'unknown' },
        { status: 'stopping', reasonCode: 'unknown' },
        { status: 'paused', reasonCode: 'user_pause' },
        { status: 'stopped', reasonCode: 'user_stop' },
        { status: 'blocked', stopReason: '等待提供密钥', reasonCode: 'blocked' },
        { status: 'failed', stopReason: '执行异常', reasonCode: 'failed' },
        { status: 'completed', reasonCode: 'completed' },
        { status: 'budget_limited', reasonCode: 'budget_limited' },
        { status: 'paused', stopReason: 'process_exit', reasonCode: 'app_restart' },
        { status: 'stopped', stopReason: 'user', reasonCode: 'user_stop' },
        { status: 'stopped', stopReason: 'max_iterations', reasonCode: 'budget_limited' },
        { status: 'stopped', stopReason: 'max_tokens', reasonCode: 'budget_limited' },
        { status: 'stopped', stopReason: 'max_duration', reasonCode: 'budget_limited' },
        { status: 'stopped', stopReason: '已达到 Goal 最大运行时长', reasonCode: 'budget_limited' },
        { status: 'paused', stopReason: 'app_restart', reasonCode: 'app_restart' },
      ]
      const states = cases.map(({ reasonCode: _expected, ...input }, index) => ({ ...legacy, ...input, id: `legacy-${index}` }))
      writeFileSync(file, JSON.stringify({ version: 2, goals: states, history: states }))
      const loaded = loadGoalStates(file)
      expect(loaded).toHaveLength(cases.length)
      cases.forEach((expected, index) => {
        expect(loaded[index]).toMatchObject({ status: expected.status, reasonCode: expected.reasonCode, lifecycle: [] })
        expect(loaded[index]?.reasonDetail).toBe(expected.stopReason)
        expect(loaded[index]?.stopReason).toBe(expected.stopReason)
      })
      expect(loadGoalHistory(file)).toEqual(loaded)
      saveGoalStates(file, [{ ...legacy, reasonCode: 'app_restart', reasonDetail: '', stopReason: 'user' }])
      expect(loadGoalStates(file)[0]).toMatchObject({ reasonCode: 'app_restart', reasonDetail: '', stopReason: 'user' })
      saveGoalStates(file, [{ ...legacy, reasonDetail: '保留详细原因', stopReason: 'process_exit' }])
      expect(loadGoalStates(file)[0]).toMatchObject({ reasonCode: 'app_restart', reasonDetail: '保留详细原因' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('schema 3 完整往返生命周期、原因、runId，归档和 live 保存互不丢失', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = lifecycleGoal()
      saveGoalStates(file, [goal])
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(3)
      expect(loadGoalStates(file)).toEqual([goal])
      const archived = {
        ...goal, status: 'stopped' as const, reasonCode: 'cleared' as const, revision: 4,
        lifecycle: [...goal.lifecycle, createGoalLifecycleEvent({ goalId: goal.id, sessionId: goal.sessionId, from: 'paused', to: 'cleared', reason: 'cleared', revision: 4, at: 1200 })],
      }
      archiveGoalState(file, archived)
      archiveGoalState(file, archived)
      expect(loadGoalHistory(file)).toEqual([archived])
      expect(loadGoalStates(file)).toEqual([])
      saveGoalStates(file, [])
      expect(loadGoalHistory(file)).toEqual([archived])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('load 严格过滤坏事件 identity、转移、原因、revision、时间和可选字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = lifecycleGoal()
      const invalid: unknown[] = invalidLifecycles(goal).map((lifecycle) => ({ ...goal, lifecycle }))
      invalid.push(
        { ...goal, reasonCode: 'legacy-reason', lifecycle: [] },
        { ...goal, reasonDetail: 1, lifecycle: [] },
        { ...goal, revision: undefined, lifecycle: goal.lifecycle },
      )
      for (const version of [1, 2, 3]) {
        writeFileSync(file, JSON.stringify({ version, goals: [...invalid, goal], history: [...invalid, goal] }))
        expect(loadGoalStates(file)).toEqual([goal])
        expect(loadGoalHistory(file)).toEqual([goal])
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('save 和 archive 拒绝全部非法事件，原文件内容不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = lifecycleGoal()
      saveGoalStates(file, [goal])
      archiveGoalState(file, goal)
      const original = readFileSync(file, 'utf8')
      const invalid: unknown[] = invalidLifecycles(goal).map((lifecycle) => ({ ...goal, lifecycle }))
      invalid.push(
        { ...goal, lifecycle: [{ ...goal.lifecycle[0], at: Infinity }] },
        { ...goal, lifecycle: [{ ...goal.lifecycle[0], revision: NaN }] },
        { ...goal, reasonCode: 'legacy-reason' },
        { ...goal, reasonDetail: 1 },
      )
      for (const state of invalid) {
        expect(() => saveGoalStates(file, [state as AgentGoalState])).toThrow('schema')
        expect(readFileSync(file, 'utf8')).toBe(original)
        expect(() => archiveGoalState(file, state as AgentGoalState)).toThrow('schema')
        expect(readFileSync(file, 'utf8')).toBe(original)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('裁剪前校验全部事件，保留创建、最近终止以及最近事件并允许 revision 间隔', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const base = lifecycleGoal()
      const lifecycle: AgentGoalLifecycleEvent[] = [base.lifecycle[0]!]
      let from: AgentGoalStatus = 'active'
      for (let revision = 2; revision <= GOAL_LIFECYCLE_LIMIT + 30; revision++) {
        const to: AgentGoalStatus = revision === 2 ? 'stopped' : revision % 2 === 0 ? 'paused' : 'active'
        const reason = to === 'stopped' ? 'user_stop' : to === 'paused' ? 'user_pause' : 'resumed'
        lifecycle.push(createGoalLifecycleEvent({ goalId: base.id, sessionId: base.sessionId, from, to, reason, revision, at: 1000 + revision }))
        from = to
      }
      const goal = { ...base, status: from, revision: GOAL_LIFECYCLE_LIMIT + 30, lifecycle }
      writeFileSync(file, JSON.stringify({ version: 3, goals: [goal], history: [goal] }))
      const original = readFileSync(file, 'utf8')
      const loaded = loadGoalStates(file)[0]!
      expect(loaded.lifecycle).toEqual([lifecycle[0]!, lifecycle[1]!, ...lifecycle.slice(-(GOAL_LIFECYCLE_LIMIT - 2))])
      expect(loadGoalHistory(file)).toEqual([loaded])
      expect(readFileSync(file, 'utf8')).toBe(original)
      const invalid = { ...goal, lifecycle: lifecycle.map((event, index) => index === 2 ? { ...event, goalId: 'wrong' } : event) }
      expect(() => saveGoalStates(file, [invalid])).toThrow('schema')
      expect(() => archiveGoalState(file, invalid)).toThrow('schema')
      expect(readFileSync(file, 'utf8')).toBe(original)
      saveGoalStates(file, [goal])
      archiveGoalState(file, goal)
      expect(loadGoalStates(file)).toEqual([loaded])
      expect(loadGoalHistory(file)).toEqual([loaded])
      expect(JSON.parse(readFileSync(file, 'utf8')).goals[0].lifecycle).toHaveLength(GOAL_LIFECYCLE_LIMIT)
      expect(goal.lifecycle).toHaveLength(GOAL_LIFECYCLE_LIMIT + 30)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('caps persisted history to the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('session-1', '长跑', 1000)
      const history = Array.from({ length: 40 }, (_, index) => ({
        iteration: index + 1,
        startedAt: 1000 + index,
        finishedAt: 1001 + index,
        status: 'continue' as const,
        summary: `第 ${index + 1} 轮`,
        evidence: [],
      }))
      saveGoalStates(file, [{ ...goal, history }])
      const loaded = loadGoalStates(file)
      expect(loaded[0]?.history).toHaveLength(20)
      expect(loaded[0]?.history?.[19]?.iteration).toBe(40)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe('Goal v2 存储故障保护', () => {
  test('合法 payload 中含非法事件时，恢复保存和归档均保留原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = lifecycleGoal()
      const bad = { ...goal, lifecycle: [{ ...goal.lifecycle[0], goalId: 'wrong' }] }
      for (const source of [ { version: 3, goals: [bad], history: [] }, { version: 3, goals: [goal], history: [bad] } ]) {
        const original = JSON.stringify(source)
        writeFileSync(file, original)
        expect(() => saveGoalStates(file, loadGoalStates(file))).toThrow('已保留原文件')
        expect(() => archiveGoalState(file, goal)).toThrow('已保留原文件')
        expect(readFileSync(file, 'utf8')).toBe(original)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Date 范围外的事件时间不能落盘或覆盖原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = lifecycleGoal()
      saveGoalStates(file, [goal])
      const original = readFileSync(file, 'utf8')
      const invalid = { ...goal, lifecycle: goal.lifecycle.map((event) => ({ ...event, at: Number.MAX_SAFE_INTEGER })) }
      expect(() => saveGoalStates(file, [invalid])).toThrow('schema')
      expect(readFileSync(file, 'utf8')).toBe(original)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
