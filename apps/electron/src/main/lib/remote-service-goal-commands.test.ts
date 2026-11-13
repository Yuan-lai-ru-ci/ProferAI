/**
 * WebUI / Pocket 的 Goal 远程命令（WS）。
 *
 * 锁三条不变量：
 * 1. Goal 服务未装配时返回可读错误而不是抛异常 —— WS 调用方是
 *    `handleRemoteCommand(...).then(...)` 且没有 `.catch`，抛出去会变成 unhandled rejection，
 *    客户端还会一直等不到 command_result；
 * 2. 缺少 sessionId / goal 时立刻拒绝，不落到状态机；
 * 3. 装配后命令转发给同一个 GoalSessionService，并按 `{ ok, data }` 契约返回；
 *    业务异常同样被转成 `{ ok: false, error }`。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentGoalState } from '@profer/shared'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-goal-ws-'))
process.env.PROFER_CONFIG_DIR = sandbox

const { handleRemoteCommand } = await import('./remote-service')
const { registerGoalSessionService } = await import('./goal-session-service')
const { goalProposalService } = await import('./goal-proposal-service')

afterAll(() => {
  registerGoalSessionService(null)
  rmSync(sandbox, { recursive: true, force: true })
})

const call = (payload: Record<string, unknown>) => handleRemoteCommand(JSON.stringify(payload))

const goalState = {
  id: 'goal-1',
  sessionId: 's1',
  goal: '把构建修好',
  status: 'active',
  iteration: 2,
  consecutiveFailures: 0,
  startedAt: 1,
  updatedAt: 2,
  limits: { maxConsecutiveFailures: 3 },
} as unknown as AgentGoalState

const calls: string[] = []

function installStub(overrides: Record<string, unknown> = {}): void {
  calls.length = 0
  const stub = {
    get: (sessionId: string) => (sessionId === 's1' ? goalState : undefined),
    history: () => [goalState],
    start: async (sessionId: string, goal: string) => { calls.push(`start:${sessionId}:${goal}`); return goalState },
    pause: async (sessionId: string) => { calls.push(`pause:${sessionId}`); return goalState },
    resume: async (sessionId: string) => { calls.push(`resume:${sessionId}`); return goalState },
    stop: async (sessionId: string) => { calls.push(`stop:${sessionId}`); return goalState },
    clear: (sessionId: string) => { calls.push(`clear:${sessionId}`) },
    update: (sessionId: string, patch: unknown) => { calls.push(`update:${sessionId}:${JSON.stringify(patch)}`); return goalState },
    ...overrides,
  }
  registerGoalSessionService(stub as unknown as Parameters<typeof registerGoalSessionService>[0])
}

describe('Goal 远程命令：未装配与参数校验', () => {
  beforeEach(() => { registerGoalSessionService(null) })

  test('Given Goal 服务尚未装配 When 调用任意 goal 命令 Then 返回可读错误而不是抛异常', async () => {
    for (const type of ['get_goal', 'get_goal_history', 'start_goal', 'pause_goal', 'resume_goal', 'stop_goal', 'clear_goal', 'update_goal']) {
      const result = await call({ type, sessionId: 's1', goal: 'x' })
      expect(result).toEqual({ ok: false, error: 'Goal 服务尚未就绪' })
    }
  })

  test('Given 缺少 sessionId When 调用 Then 立刻拒绝，不进入状态机', async () => {
    installStub()
    expect(await call({ type: 'get_goal' })).toEqual({ ok: false, error: '缺少 sessionId' })
    expect(await call({ type: 'pause_goal', sessionId: '   ' })).toEqual({ ok: false, error: '缺少 sessionId' })
    expect(calls).toEqual([])
  })

  test('Given 缺少目标文本 When 启动 Goal Then 拒绝，不创建空目标', async () => {
    installStub()
    expect(await call({ type: 'start_goal', sessionId: 's1', goal: '   ' })).toEqual({ ok: false, error: '缺少 sessionId 或 goal' })
    expect(calls).toEqual([])
  })
})

describe('Goal 远程命令：转发与返回契约', () => {
  beforeEach(() => { installStub() })

  test('Given 会话有 Goal When 查询 Then 返回完整状态；无 Goal 时返回 null', async () => {
    expect(await call({ type: 'get_goal', sessionId: 's1' })).toEqual({ ok: true, data: { goal: goalState } })
    expect(await call({ type: 'get_goal', sessionId: 'other' })).toEqual({ ok: true, data: { goal: null } })
  })

  test('Given 查询历史 When 调用 Then 返回归档列表', async () => {
    expect(await call({ type: 'get_goal_history', sessionId: 's1' })).toEqual({ ok: true, data: { goals: [goalState] } })
  })

  test('Given 启动/暂停/恢复/停止 When 调用 Then 转发到同一个服务实例', async () => {
    expect(await call({ type: 'start_goal', sessionId: 's1', goal: '  把构建修好  ' })).toEqual({ ok: true, data: { goal: goalState } })
    await call({ type: 'pause_goal', sessionId: 's1' })
    await call({ type: 'resume_goal', sessionId: 's1' })
    await call({ type: 'stop_goal', sessionId: 's1' })
    expect(calls).toEqual(['start:s1:  把构建修好  ', 'pause:s1', 'resume:s1', 'stop:s1'])
  })

  test('Given 清除 Goal When 调用 Then 透传并返回 sessionId', async () => {
    expect(await call({ type: 'clear_goal', sessionId: 's1' })).toEqual({ ok: true, data: { sessionId: 's1' } })
    expect(calls).toEqual(['clear:s1'])
  })

  test('Given 修改目标与预算 When 调用 Then 只透传允许的字段', async () => {
    await call({ type: 'update_goal', sessionId: 's1', goal: '新目标', limits: { maxIterations: 5 }, 无关字段: 1 })
    expect(calls).toEqual(['update:s1:{"goal":"新目标","limits":{"maxIterations":5}}'])
  })

  test('Given 状态机抛业务错误 When 调用 Then 转成 {ok:false}，不向事件循环抛异常', async () => {
    installStub({ start: async () => { throw new Error('当前会话有未完成的 Goal，请先恢复或明确清除它') } })
    expect(await call({ type: 'start_goal', sessionId: 's1', goal: 'x' }))
      .toEqual({ ok: false, error: '当前会话有未完成的 Goal，请先恢复或明确清除它' })
  })
})

/**
 * 模型主动提议建立 Goal 的确认。
 *
 * 锁的不变量是「建 Goal 失败时提议必须留在队列里」：
 * 若失败也出队，卡片会消失，用户既看不到原因也无法重试。
 */
describe('Goal 提议确认：respond_goal_proposal', () => {
  const resetProposals = (): void => {
    for (const proposal of goalProposalService.list()) goalProposalService.remove(proposal.id)
  }

  const seedProposal = (): string => {
    const created = goalProposalService.add('s1', {
      objective: '把这批测试补到全绿',
      rationale: '涉及多个模块，需要多轮',
      verification: 'bun test 全过',
    })
    if (!created) throw new Error('测试数据构造失败')
    return created.proposal.id
  }

  beforeEach(() => {
    installStub()
    resetProposals()
  })

  afterAll(resetProposals)

  test('Given 缺少 proposalId When 调用 Then 拒绝，不触碰队列', async () => {
    expect(await call({ type: 'respond_goal_proposal', accepted: true }))
      .toEqual({ ok: false, error: '缺少 proposalId' })
  })

  test('Given 提议不存在 When 调用 Then 返回可读错误', async () => {
    expect(await call({ type: 'respond_goal_proposal', proposalId: 'not-exist', accepted: true }))
      .toEqual({ ok: false, error: '该提议不存在或已处理' })
  })

  test('Given 批准提议 When 调用 Then 用提议的目标启动 Goal 并出队', async () => {
    const proposalId = seedProposal()
    expect(await call({ type: 'respond_goal_proposal', proposalId, accepted: true }))
      .toEqual({ ok: true, data: { sessionId: 's1' } })
    expect(calls).toEqual(['start:s1:把这批测试补到全绿'])
    expect(goalProposalService.peek(proposalId)).toBeNull()
  })

  test('Given 忽略提议 When 调用 Then 不启动 Goal 但出队', async () => {
    const proposalId = seedProposal()
    expect(await call({ type: 'respond_goal_proposal', proposalId, accepted: false }))
      .toEqual({ ok: true, data: { sessionId: 's1' } })
    expect(calls).toEqual([])
    expect(goalProposalService.peek(proposalId)).toBeNull()
  })

  test('Given 创建 Goal 失败 When 批准 Then 返回原因且提议保留，允许重试', async () => {
    installStub({ start: async () => { throw new Error('当前会话有未完成的 Goal，请先恢复或明确清除它') } })
    const proposalId = seedProposal()
    expect(await call({ type: 'respond_goal_proposal', proposalId, accepted: true }))
      .toEqual({ ok: false, error: '当前会话有未完成的 Goal，请先恢复或明确清除它' })
    expect(goalProposalService.peek(proposalId)).not.toBeNull()
  })

  test('Given Goal 服务未装配 When 批准 Then 返回可读错误且提议保留', async () => {
    const proposalId = seedProposal()
    registerGoalSessionService(null)
    expect(await call({ type: 'respond_goal_proposal', proposalId, accepted: true }))
      .toEqual({ ok: false, error: 'Goal 服务尚未就绪' })
    expect(goalProposalService.peek(proposalId)).not.toBeNull()
  })
})
