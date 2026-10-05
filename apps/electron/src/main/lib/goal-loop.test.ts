import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_GOAL_LIMITS,
  buildGoalIterationPrompt,
  goalBudgetReason,
  isGoalNearBudget,
  createGoalState,
  evaluateGoalContinuation,
  parseGoalCommand,
  parseGoalIterationResult,
  pauseGoalForProcessExit,
  stopGoalForProcessExit,
} from './goal-loop'

describe('goal loop', () => {
  test('parses a goal command and control commands', () => {
    expect(parseGoalCommand('/goal 完成登录页')).toEqual({ type: 'start', goal: '完成登录页', contract: undefined })
    expect(parseGoalCommand('/goal status')).toEqual({ type: 'status' })
    expect(parseGoalCommand('/goal pause')).toEqual({ type: 'pause' })
    expect(parseGoalCommand('/goal resume')).toEqual({ type: 'resume' })
    expect(parseGoalCommand('/goal stop')).toEqual({ type: 'stop' })
    expect(parseGoalCommand('/goal clear')).toEqual({ type: 'clear' })
    expect(parseGoalCommand('普通消息')).toEqual({ type: 'not_goal' })
  })

  test('parses a goal contract from line markers', () => {
    const command = parseGoalCommand('/goal 完成登录页\n@verify: bun test login 通过\n@constraint: 不改支付代码\n@stop: 需要生产凭据时')
    expect(command).toEqual({
      type: 'start',
      goal: '完成登录页',
      contract: { verification: 'bun test login 通过', constraints: '不改支付代码', stopWhen: '需要生产凭据时' },
    })
  })

  test('rejects an empty goal and unknown command', () => {
    expect(parseGoalCommand('/goal').type).toBe('invalid')
    expect(parseGoalCommand('/goal maybe')).toEqual({ type: 'invalid', reason: '未知的 Goal 命令：maybe' })
    expect(parseGoalCommand('/goal\n@verify: 只有标记没有目标').type).toBe('invalid')
  })

  test('iteration prompt carries contract, budget and history', () => {
    const state = createGoalState('s1', '完成登录页', 1000, { maxIterations: 20, maxDurationMs: 7200000, maxConsecutiveFailures: 3 }, { verification: '测试通过', stopWhen: '需要凭据' })
    // state.iteration 由 GoalController 在进入本轮前自增，prompt 直接使用当前值
    const prompt = buildGoalIterationPrompt({ ...state, iteration: 3 }, { previousSummary: '上一轮完成了表单', now: 2000 })
    expect(prompt).toContain('目标：完成登录页')
    expect(prompt).toContain('验收标准（verify）：测试通过')
    expect(prompt).toContain('停止条件（stop）：需要凭据')
    expect(prompt).toContain('第 3 轮')
    expect(prompt).toContain('上一轮摘要：上一轮完成了表单')
    expect(prompt).toContain('update_goal')
    expect(prompt).not.toContain('<goal_result>')
    expect(prompt).toContain('逐项')
    expect(prompt).toContain('无进展')
    expect(prompt).toContain('剩余预算：约 17 轮 / 约 120 分钟')
    expect(prompt).not.toContain('预算即将用完')
  })

  test('不再要求每轮都调用 update_goal：未完成时正常结束本轮即可', () => {
    const prompt = buildGoalIterationPrompt({ ...createGoalState('s1', '优化性能', 1000), iteration: 1 }, {})
    expect(prompt).not.toContain('每轮结束时必须调用')
    expect(prompt).toContain('正常结束本轮即可')
    expect(prompt).not.toContain('剩余预算')
  })

  test('预算接近用完时追加收尾提示', () => {
    const base = createGoalState('s1', '迁移', 0, { maxIterations: 5, maxConsecutiveFailures: 3 })
    expect(isGoalNearBudget({ ...base, iteration: 4 })).toBe(false)
    expect(isGoalNearBudget({ ...base, iteration: 5 })).toBe(true)
    expect(isGoalNearBudget({ ...base, limits: { maxConsecutiveFailures: 3, maxTokens: 100 }, usage: { inputTokens: 70, outputTokens: 10, totalTokens: 80 } })).toBe(true)
    expect(isGoalNearBudget({ ...base, limits: { maxConsecutiveFailures: 3, maxDurationMs: 1000 }, elapsedMs: 700 })).toBe(false)
    expect(buildGoalIterationPrompt({ ...base, iteration: 5 }, {})).toContain('预算即将用完')
  })

  test('未设置的预算不会耗尽', () => {
    expect(goalBudgetReason({ iteration: 10_000, elapsedMs: 9e9, limits: DEFAULT_GOAL_LIMITS })).toBeUndefined()
  })

  test('iteration prompt asks for a verification surface when contract is missing', () => {
    const state = createGoalState('s1', '优化性能', 1000)
    const prompt = buildGoalIterationPrompt(state, { now: 1000 })
    expect(prompt).toContain('验收标准')
  })

  test('process exit pauses an active goal for later resume', () => {
    const goal = createGoalState('session-1', '完成登录页', 1000)
    const paused = pauseGoalForProcessExit(goal, 2000)
    expect(paused).toMatchObject({ status: 'paused', stopReason: 'app_restart', updatedAt: 2000 })
  })

  test('iteration result picks the real report over prompt examples', () => {
    // 会话历史中同时存在控制 prompt 里的协议示例与本轮真实输出
    const text = [
      '每轮结束时必须输出：<goal_result>{"status":"continue|complete|blocked","summary":"...","evidence":["..."]}</goal_result>',
      '助手本轮输出……',
      '<goal_result>{"status":"complete","summary":"已交付","evidence":["bun test 全绿"]}</goal_result>',
    ].join('\n')
    expect(parseGoalIterationResult(text)).toEqual({ status: 'complete', summary: '已交付', evidence: ['bun test 全绿'] })
  })

  test('iteration result skips invalid json blocks and prompt examples', () => {
    const text = [
      '<goal_result>{not json}</goal_result>',
      '<goal_result>{"status":"continue|complete|blocked"}</goal_result>',
    ].join('\n')
    const result = parseGoalIterationResult(text)
    expect(result.status).toBe('continue')
    expect(result.summary).toContain('解析失败')
    expect(parseGoalIterationResult('没有任何标记')).toEqual({ status: 'continue', summary: '没有任何标记', evidence: [] })
  })

  test('creates an active goal with safe defaults', () => {
    const goal = createGoalState('session-1', '完成登录页', 1000)
    expect(goal).toMatchObject({
      sessionId: 'session-1',
      goal: '完成登录页',
      status: 'active',
      iteration: 0,
      startedAt: 1000,
      updatedAt: 1000,
      limits: DEFAULT_GOAL_LIMITS,
    })
    expect(goal.id).toBeString()
  })

  test('continues when the agent has not completed the goal', () => {
    const result = evaluateGoalContinuation({
      status: 'continue',
      summary: '已完成代码修改，准备运行测试',
      evidence: ['已修改 src/login.ts'],
    }, { iteration: 1, consecutiveFailures: 0, startedAt: 1000, now: 2000, limits: DEFAULT_GOAL_LIMITS })
    expect(result).toEqual({ action: 'continue', consecutiveFailures: 0 })
  })

  test('completes only with explicit evidence', () => {
    const result = evaluateGoalContinuation({
      status: 'complete',
      summary: '目标已完成',
      evidence: ['bun test passed'],
    }, { iteration: 2, consecutiveFailures: 0, startedAt: 1000, now: 2000, limits: DEFAULT_GOAL_LIMITS })
    expect(result).toEqual({ action: 'complete', consecutiveFailures: 0 })
  })

  test('没有证据的 continue 不算失败，失败计数清零', () => {
    const result = evaluateGoalContinuation({ status: 'continue', summary: '改了一半', evidence: [] }, {
      iteration: 1, consecutiveFailures: 2, startedAt: 0, now: 0, limits: DEFAULT_GOAL_LIMITS,
    })
    expect(result).toEqual({ action: 'continue', consecutiveFailures: 0 })
  })

  test('pauses after repeated failures or limits', () => {
    const result = evaluateGoalContinuation({ status: 'continue', summary: '失败', evidence: [] }, {
      iteration: 1,
      consecutiveFailures: DEFAULT_GOAL_LIMITS.maxConsecutiveFailures - 1,
      startedAt: 1000,
      now: 2000,
      limits: DEFAULT_GOAL_LIMITS,
      turnFailed: true,
    })
    expect(result.action).toBe('failed')

    const timedOut = evaluateGoalContinuation({ status: 'continue', summary: '继续', evidence: [] }, {
      iteration: 1,
      consecutiveFailures: 0,
      startedAt: 1000,
      now: 1000 + 7200000 + 1,
      limits: { ...DEFAULT_GOAL_LIMITS, maxDurationMs: 7200000 },
    })
    expect(timedOut.action).toBe('limit_reached')
  })

  test('最后一轮验收通过优先 complete，空白证据不能完成', () => {
    const limits = { maxIterations: 20, maxDurationMs: 7200000, maxConsecutiveFailures: 3 }
    const context = { iteration: 20, consecutiveFailures: 0, startedAt: 0, now: 7200000, elapsedMs: 7200000, limits }
    expect(evaluateGoalContinuation({ status: 'complete', summary: '完成', evidence: ['测试通过'] }, context).action).toBe('complete')
    expect(evaluateGoalContinuation({ status: 'complete', summary: '完成', evidence: ['   '] }, context).action).toBe('limit_reached')
  })

  test('token 耗尽与 typed stopped/deferred 独立于成功', () => {
    const context = { iteration: 1, consecutiveFailures: 2, startedAt: 0, now: 99999999, elapsedMs: 0, totalTokens: 10, limits: { ...DEFAULT_GOAL_LIMITS, maxTokens: 10 } }
    expect(evaluateGoalContinuation({ status: 'continue', summary: '继续', evidence: [] }, context).action).toBe('limit_reached')
    expect(evaluateGoalContinuation({ status: 'complete', outcome: 'stopped', summary: '停止', evidence: ['证据'] }, context).action).toBe('stopped')
    expect(evaluateGoalContinuation({ status: 'continue', outcome: 'deferred', summary: 'busy', evidence: [] }, context)).toEqual({ action: 'deferred', consecutiveFailures: 2 })
  })

  test('无进展与无证据 complete 按失败策略记账', () => {
    const context = { iteration: 1, consecutiveFailures: 2, startedAt: 0, now: 0, elapsedMs: 0, limits: DEFAULT_GOAL_LIMITS }
    expect(evaluateGoalContinuation({ status: 'continue', outcome: 'failed', summary: '空回复', evidence: [] }, context).action).toBe('failed')
    expect(evaluateGoalContinuation({ status: 'complete', summary: '声称完成', evidence: [''] }, context).action).toBe('failed')
  })

  test('process exit stops an active goal without pretending it completed', () => {
    const goal = createGoalState('session-1', '完成登录页', 1000)
    const stopped = stopGoalForProcessExit(goal, 2000)
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'process_exit', updatedAt: 2000 })
  })
})
