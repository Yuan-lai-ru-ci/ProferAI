import { describe, expect, test } from 'bun:test'
import type { AgentGoalOverviewEntry, AgentGoalState } from '@profer/shared'
import { buildGoalOverviewSections, formatGoalBudgetUsage, goalOverviewSummary, groupGoalEntriesByWorkspace, sortGoalEntries } from './GoalOverviewList'

const goal = (patch: Partial<AgentGoalState> = {}): AgentGoalState => ({
  id: 'goal', sessionId: 'session', goal: '目标', status: 'active', revision: 1, iteration: 3,
  consecutiveFailures: 0, startedAt: 100, updatedAt: 1_000, elapsedMs: 120_000,
  limits: { maxConsecutiveFailures: 3 }, ...patch,
})

const entry = (patch: Partial<AgentGoalState>, archived = false): AgentGoalOverviewEntry => ({ goal: goal(patch), archived })

describe('Goal 总览列表', () => {
  test('排序把需要关注的状态放前面，同状态按最近更新', () => {
    const sorted = sortGoalEntries([
      entry({ id: 'done', status: 'completed', updatedAt: 9_000 }),
      entry({ id: 'run-old', status: 'active', updatedAt: 2_000 }),
      entry({ id: 'blocked', status: 'blocked', updatedAt: 1_000 }),
      entry({ id: 'run-new', status: 'active', updatedAt: 5_000 }),
      entry({ id: 'paused', status: 'paused', updatedAt: 8_000 }),
    ])
    expect(sorted.map((item) => item.goal.id)).toEqual(['blocked', 'run-new', 'run-old', 'paused', 'done'])
  })

  test('预算摘要只列出已设置的维度', () => {
    expect(formatGoalBudgetUsage(goal())).toBe('不限预算')
    expect(formatGoalBudgetUsage(goal({ limits: { maxConsecutiveFailures: 3, maxIterations: 10 } }))).toBe('3/10 轮')
    expect(formatGoalBudgetUsage(goal({
      limits: { maxConsecutiveFailures: 3, maxDurationMs: 600_000, maxTokens: 50_000 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 12_000 },
    }))).toContain('2/10 分钟')
  })

  test('摘要优先模型结论，其次原因；暂停不冒充失败', () => {
    expect(goalOverviewSummary(goal({ status: 'completed', lastSummary: '测试全绿', stopReason: 'completed' }))).toBe('测试全绿')
    expect(goalOverviewSummary(goal({ status: 'paused', reasonCode: 'user_pause', lastSummary: '做到一半' }))).toBe('用户暂停')
    expect(goalOverviewSummary(goal({ status: 'failed', reasonCode: 'failed', lastSummary: '构建失败' }))).toBe('构建失败')
    expect(goalOverviewSummary(goal({ status: 'active', lastSummary: '' }))).toBe('执行中')
    expect(goalOverviewSummary(goal({ status: 'stopped', reasonCode: 'cleared', stopReason: 'cleared' }))).toBe('清除并归档')
  })

  test('live 条目补会话标题，终态 Goal 归到最近结束并与归档去重', () => {
    const titles = new Map<string, string | undefined>([['session', '登录页改造']])
    const sections = buildGoalOverviewSections(
      [
        goal({ id: 'run', sessionId: 'session', status: 'active' }),
        goal({ id: 'done', sessionId: 'session', status: 'completed', updatedAt: 9_000 }),
      ],
      [entry({ id: 'archived', status: 'stopped', updatedAt: 5_000 }, true), entry({ id: 'done', status: 'completed', updatedAt: 8_000 }, true)],
      titles,
    )
    expect(sections.live.map((item) => item.goal.id)).toEqual(['run'])
    // 会话标题必须从会话索引补：渲染层拿到的 live 条目没有 sessionTitle
    expect(sections.live[0]?.sessionTitle).toBe('登录页改造')
    // 终态 live Goal 归到最近结束，且同 id 不重复；按结束时间倒序
    expect(sections.ended.map((item) => item.goal.id)).toEqual(['done', 'archived'])
    expect(sections.ended[0]?.archived).toBe(false)
  })

  test('会话已删除时标题保持空，由渲染层展示占位文案', () => {
    const sections = buildGoalOverviewSections([goal({ sessionId: 'missing' })], [], new Map())
    expect(sections.live[0]?.sessionTitle).toBeUndefined()
  })
})

describe('Goal 总览按项目分组', () => {
  const entry = (id: string, workspaceId: string | undefined, status: AgentGoalState['status'], updatedAt = 1000): AgentGoalOverviewEntry => ({
    goal: { id, sessionId: `s-${id}`, status, updatedAt } as AgentGoalState,
    workspaceId,
    archived: false,
  })
  const names = new Map([['w1', 'Profer'], ['w2', '小程序'], ['w3', '文档站']])

  test('只有一个项目时不分组，直接平铺（单项目用户不该多一层噪音）', () => {
    const groups = groupGoalEntriesByWorkspace([entry('a', 'w1', 'active'), entry('b', 'w1', 'paused')], names)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.workspaceName).toBe('Profer')
    expect(groups[0]?.entries).toHaveLength(2)
  })

  test('多个项目时按项目分开，不同会话的 Goal 不再混成一串', () => {
    const groups = groupGoalEntriesByWorkspace([
      entry('a', 'w1', 'active'),
      entry('b', 'w2', 'active'),
      entry('c', 'w1', 'blocked'),
    ], names)
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.workspaceName).sort()).toEqual(['Profer', '小程序'])
    const profer = groups.find((group) => group.workspaceId === 'w1')
    expect(profer?.entries.map((item) => item.goal.id)).toEqual(['a', 'c'])
  })

  test('有目标待处理的项目排在前面', () => {
    const groups = groupGoalEntriesByWorkspace([
      entry('a', 'w1', 'active', 9000),
      entry('b', 'w2', 'blocked', 1000),
    ], names)
    expect(groups[0]?.workspaceId).toBe('w2')
  })

  test('都在跑时按最近更新排', () => {
    const groups = groupGoalEntriesByWorkspace([
      entry('a', 'w1', 'active', 1000),
      entry('b', 'w2', 'active', 9000),
    ], names)
    expect(groups.map((group) => group.workspaceId)).toEqual(['w2', 'w1'])
  })

  test('会话已删除（无工作区）的条目单独成组并沉到最后', () => {
    const groups = groupGoalEntriesByWorkspace([
      entry('a', undefined, 'active', 9000),
      entry('b', 'w1', 'active', 1000),
    ], names)
    expect(groups.map((group) => group.workspaceName)).toEqual(['Profer', '会话已删除'])
  })

  test('工作区存在但不在索引里时显示「未知项目」，不丢条目', () => {
    const groups = groupGoalEntriesByWorkspace([entry('a', 'w9', 'active')], names)
    expect(groups[0]?.workspaceName).toBe('未知项目')
    expect(groups[0]?.entries).toHaveLength(1)
  })
})
