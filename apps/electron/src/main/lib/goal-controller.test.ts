import { describe, expect, test } from 'bun:test'
import { GoalController } from './goal-controller'
import { createGoalState } from './goal-loop'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('GoalController', () => {
  test('runs one turn and schedules the next turn after continue', async () => {
    const runs: string[] = []
    const completions = deferred<void>()
    const controller = new GoalController({
      runTurn: async ({ state }) => { runs.push(`run-${state.iteration}`); await completions.promise; return { status: 'continue', summary: '继续', evidence: ['已执行'] } },
      stopTurn: async () => {},
      onStateChange: () => {},
      // 默认不限轮次：用宏任务调度，避免 continue 循环饿死测试计时器。
      schedule: (callback) => setTimeout(callback, 0),
      cancelSchedule: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })

    await controller.start('session-1', '完成目标')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toEqual(['run-1'])
    completions.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runs.length).toBeGreaterThan(1)
    await controller.stop('session-1')
    expect(controller.get('session-1')?.status).toBe('stopped')
  })

  test('persists the runtime session ID and reuses it on the next iteration', async () => {
    const runtimeSessionIds: Array<string | undefined> = []
    let reportRuntimeSessionId!: (id: string, file?: string) => void
    const controller = new GoalController({
      runTurn: async ({ runtimeSessionId, onRuntimeSessionId }) => {
        runtimeSessionIds.push(runtimeSessionId)
        reportRuntimeSessionId = onRuntimeSessionId
        if (!runtimeSessionId) onRuntimeSessionId('goal-runtime-1', '/tmp/goal-runtime-1.jsonl')
        return runtimeSessionIds.length === 1
          ? { status: 'continue', summary: '继续', evidence: [] }
          : { status: 'blocked', summary: '等待用户', evidence: [] }
      },
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '隔离目标')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runtimeSessionIds[0]).toBeUndefined()
    expect(controller.get('session-1')).toMatchObject({ runtimeSessionId: 'goal-runtime-1', runtimeSessionFile: '/tmp/goal-runtime-1.jsonl' })
    reportRuntimeSessionId('goal-runtime-1', '/tmp/goal-runtime-1.jsonl')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runtimeSessionIds[1]).toBe('goal-runtime-1')
  })
  test('allows a new goal after the previous goal reached a terminal state', async () => {
    const goals: string[] = []
    const controller = new GoalController({
      runTurn: async ({ state }) => {
        goals.push(state.goal)
        return { status: 'complete', summary: `${state.goal} 完成`, evidence: ['已验证'] }
      },
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '第一个目标')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(controller.get('session-1')?.status).toBe('completed')

    const second = await controller.start('session-1', '第二个目标')
    expect(second.goal).toBe('第二个目标')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(goals).toEqual(['第一个目标', '第二个目标'])
    expect(controller.get('session-1')?.status).toBe('completed')
  })

  test('does not replace an active goal implicitly', async () => {
    const completions = deferred<void>()
    let runCount = 0
    const controller = new GoalController({
      runTurn: async () => { runCount++; await completions.promise; return { status: 'continue', summary: '继续', evidence: ['已执行'] } },
      stopTurn: async () => { completions.resolve() },
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '正在运行的目标')
    let error = ''
    try {
      await controller.start('session-1', '不应覆盖的目标')
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    expect(error).toContain('正在运行')
    await controller.stop('session-1')
    await Promise.resolve()
    expect(runCount).toBe(1)
    expect(controller.get('session-1')?.status).toBe('stopped')
  })

  test('records iteration history and contract on start', async () => {
    const controller = new GoalController({
      runTurn: async () => ({ status: 'complete', summary: '全部完成', evidence: ['测试通过'], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '完成目标', { verification: '测试通过' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const state = controller.get('session-1')
    expect(state?.status).toBe('completed')
    expect(state?.contract).toEqual({ verification: '测试通过' })
    expect(state?.history).toHaveLength(1)
    expect(state?.history?.[0]).toMatchObject({ iteration: 1, status: 'complete', summary: '全部完成', evidence: ['测试通过'], usage: { totalTokens: 15 } })
    expect(state?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  test('restore downgrades active goals to paused and lists them', async () => {
    const controller = new GoalController({
      runTurn: async () => ({ status: 'continue', summary: '', evidence: [] }),
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })
    const active = createGoalState('session-1', '长跑目标', 1000)
    const completed = { ...createGoalState('session-2', '已完成目标', 1000), status: 'completed' as const }
    controller.restore([active, completed])
    expect(controller.get('session-1')?.status).toBe('paused')
    expect(controller.get('session-1')?.stopReason).toBe('app_restart')
    expect(controller.get('session-2')?.status).toBe('completed')
    expect(controller.list()).toHaveLength(2)
    // 恢复后的 paused goal 可以显式恢复执行
    const runs: number[] = []
    const controller2 = new GoalController({
      runTurn: async ({ state }) => { runs.push(state.iteration); return { status: 'blocked', summary: '需要用户输入', evidence: [] } },
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })
    controller2.restore([{ ...active, startedAt: Date.now() }])
    await controller2.resume('session-1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runs.length).toBeGreaterThan(0)
    expect(controller2.get('session-1')?.status).toBe('blocked')
  })

  test('stopAll pauses active goals for process exit instead of dropping them', async () => {
    const completions = deferred<void>()
    const controller = new GoalController({
      runTurn: async () => { await completions.promise; return { status: 'continue', summary: '', evidence: [] } },
      stopTurn: async () => { completions.resolve() },
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })
    await controller.start('session-1', '长跑目标')
    controller.stopAll()
    expect(controller.get('session-1')?.status).toBe('paused')
    expect(controller.get('session-1')?.stopReason).toBe('app_restart')
  })
})

// 审计边界：用可控时钟/调度器验证控制器，不调用真实 runtime。
function controlledGoalHarness(overrides: Partial<ConstructorParameters<typeof GoalController>[0]> = {}) {
  let clock = 1000
  let nextHandle = 0
  const scheduled = new Map<number, { callback: () => void; delay: number }>()
  const deadlines = new Map<number, { callback: () => void; delay: number }>()
  const events: import('@profer/shared').AgentGoalState[] = []
  const controller = new GoalController({
    runTurn: async () => ({ status: 'continue', summary: '已执行', evidence: ['修改文件'] }),
    stopTurn: async () => {},
    now: () => clock,
    onStateChange: (state) => events.push(state),
    schedule: (callback, delay = 0) => { const id = ++nextHandle; scheduled.set(id, { callback, delay }); return id },
    cancelSchedule: (handle) => { scheduled.delete(handle as number) },
    setTimer: (callback, delay) => { const id = ++nextHandle; deadlines.set(id, { callback, delay }); return id },
    clearTimer: (handle) => { deadlines.delete(handle as number) },
    ...overrides,
  })
  const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }
  const dispatch = async () => {
    const entry = scheduled.entries().next().value
    if (entry) { scheduled.delete(entry[0]); entry[1].callback() }
    await flush()
  }
  return { controller, events, scheduled, deadlines, dispatch, flush, advance: (ms: number) => { clock += ms } }
}

describe('GoalController 审计边界', () => {
  test('整体恢复不 emit，stopping 也降级 paused', () => {
    const h = controlledGoalHarness()
    h.controller.restore([createGoalState('a', '目标A'), { ...createGoalState('b', '目标B'), status: 'stopping' }])
    expect(h.events).toEqual([])
    expect(h.controller.list()).toHaveLength(2)
    expect(h.controller.get('b')?.status).toBe('paused')
  })

  test.each(['blocked', 'failed', 'stopped'] as const)('%s 保留目标，需要显式 resume 或 clear', async (status) => {
    const h = controlledGoalHarness()
    h.controller.restore([{ ...createGoalState('s', '原目标'), status }])
    await expect(h.controller.start('s', '替换')).rejects.toThrow()
    await h.controller.resume('s')
    await h.dispatch()
    expect(h.controller.get('s')?.iteration).toBe(1)
  })

  test('dispatch 前检查预算；耗尽后加预算才能恢复', async () => {
    let runs = 0
    const h = controlledGoalHarness({ runTurn: async () => { runs++; return { status: 'continue', summary: '推进', evidence: ['证据'] } } })
    h.controller.restore([{ ...createGoalState('s', '目标', 1000, { maxIterations: 20, maxConsecutiveFailures: 3 }), status: 'paused', iteration: 20 }])
    await expect(h.controller.resume('s')).rejects.toThrow('预算')
    expect(h.controller.get('s')?.status).toBe('budget_limited')
    expect(runs).toBe(0)
    h.controller.update('s', { limits: { maxIterations: 21 } })
    await h.controller.resume('s')
    await h.dispatch()
    expect(runs).toBe(1)
    expect(h.controller.get('s')?.status).toBe('budget_limited')
  })

  test('最后完整轮 complete 优先，暂停时间不计预算', async () => {
    const h = controlledGoalHarness({ runTurn: async () => ({ status: 'complete', summary: '完成', evidence: ['测试通过'] }) })
    h.controller.restore([{ ...createGoalState('s', '目标', 0), status: 'paused', iteration: 19, elapsedMs: 5 }])
    h.advance(10_000_000)
    await h.controller.resume('s')
    await h.dispatch()
    expect(h.controller.get('s')?.status).toBe('completed')
    expect(h.controller.get('s')?.elapsedMs).toBe(5)
  })

  test('canRun 忙时延迟，不消耗轮次或失败次数', async () => {
    let busy = true
    const h = controlledGoalHarness({ canRun: () => !busy })
    await h.controller.start('s', '目标')
    await h.dispatch()
    expect(h.controller.get('s')?.iteration).toBe(0)
    expect([...h.scheduled.values()][0]?.delay).toBeGreaterThan(0)
    busy = false
    await h.dispatch()
    expect(h.controller.get('s')?.iteration).toBe(1)
  })

  test('deferred 不计成功、iteration、history 或 execution time', async () => {
    const h = controlledGoalHarness({ runTurn: async () => ({ status: 'continue', outcome: 'deferred', summary: 'busy', evidence: [] }) })
    await h.controller.start('s', '目标')
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ iteration: 0, consecutiveFailures: 0, history: [], elapsedMs: 0 })
  })

  test('真实失败累计三次并保留 history，stopped 不续跑', async () => {
    const h = controlledGoalHarness({ runTurn: async () => { throw new Error('runtime error') } })
    await h.controller.start('s', '目标')
    await h.dispatch(); await h.dispatch(); await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'failed', iteration: 3, consecutiveFailures: 3 })
    expect(h.controller.get('s')?.history).toHaveLength(3)
    const stopped = controlledGoalHarness({ runTurn: async () => ({ status: 'continue', outcome: 'stopped', summary: '用户停止', evidence: [] }) })
    await stopped.controller.start('s', '目标')
    await stopped.dispatch()
    expect(stopped.controller.get('s')?.status).toBe('stopped')
    expect(stopped.scheduled.size).toBe(0)
  })

  test('stop 超时后状态收敛但 owner 未释放禁止恢复、clear、update', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const stop = deferred<void>()
    const h = controlledGoalHarness({ runTurn: () => turn.promise, stopTurn: () => stop.promise })
    await h.controller.start('s', '目标')
    await h.dispatch()
    const stopping = h.controller.stop('s')
    expect(h.controller.get('s')?.status).toBe('stopping')
    for (const timer of [...h.deadlines.values()]) if (timer.delay === 5000) timer.callback()
    await stopping
    expect(h.controller.get('s')?.status).toBe('stopped')
    await expect(h.controller.resume('s')).rejects.toThrow()
    expect(() => h.controller.clear('s')).toThrow()
    expect(() => h.controller.update('s', { goal: '另一个目标' })).toThrow()
    turn.resolve({ status: 'complete', summary: '迟到', evidence: ['证据'] })
    await h.flush()
    expect(h.controller.get('s')?.status).toBe('stopped')
    h.controller.clear('s')
    const replacement = await h.controller.start('s', '新目标')
    const revision = replacement.revision
    stop.resolve()
    await h.flush()
    expect(h.controller.get('s')?.id).toBe(replacement.id)
    expect(h.controller.get('s')?.revision).toBe(revision)
  })

  test('stop rejection 仍收敛，暂停运行消息回调无效', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    let report!: (id: string) => void
    const h = controlledGoalHarness({ runTurn: ({ onRuntimeSessionId }) => { report = onRuntimeSessionId; return turn.promise }, stopTurn: async () => { throw new Error('stop failed') } })
    await h.controller.start('s', '目标')
    await h.dispatch()
    await h.controller.pause('s')
    const revision = h.controller.get('s')?.revision
    report('late')
    expect(h.controller.get('s')?.revision).toBe(revision)
    expect(h.controller.get('s')?.status).toBe('paused')
    await expect(h.controller.resume('s')).rejects.toThrow()
    turn.resolve({ status: 'continue', summary: '迟到', evidence: ['证据'] })
    await h.flush()
    await h.controller.resume('s')
    expect(h.controller.get('s')?.status).toBe('active')
  })

  test('旧 pause await 晚返回不能把已resume 的 Goal重新暂停', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const stop = deferred<void>()
    const h = controlledGoalHarness({ runTurn: () => turn.promise, stopTurn: () => stop.promise })
    await h.controller.start('s', '目标')
    await h.dispatch()
    const pause = h.controller.pause('s')
    turn.resolve({ status: 'continue', summary: '迟到', evidence: ['证据'] })
    await h.flush()
    // runtime 已释放但控制操作仍 await；不允许恢复 stopping。
    await expect(h.controller.resume('s')).rejects.toThrow()
    stop.resolve()
    await pause
    await h.controller.resume('s')
    expect(h.controller.get('s')?.status).toBe('active')
  })

  test('failed 的显式resume 给新的失败重试窗口，更新预算严格校验', async () => {
    const h = controlledGoalHarness()
    h.controller.restore([{ ...createGoalState('s', '目标', 1000), status: 'failed', consecutiveFailures: 3 }])
    expect(() => h.controller.update('s', { limits: { maxIterations: NaN } })).toThrow()
    expect(() => h.controller.update('s', { limits: { maxIterations: 1.5 } })).toThrow()
    expect(() => h.controller.update('s', { goal: ' ' })).toThrow()
    await h.controller.resume('s')
    expect(h.controller.get('s')?.consecutiveFailures).toBe(0)
  })

  test('restore 不能丢弃仍活跃 owner', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const h = controlledGoalHarness({ runTurn: () => turn.promise })
    await h.controller.start('s', '目标')
    await h.dispatch()
    expect(() => h.controller.restore([])).toThrow()
    turn.resolve({ status: 'complete', summary: '完成', evidence: ['证据'] })
    await h.flush()
  })

  test('同会话revision 跨完成后替换单调，旧 scheduler 重复触发无效', async () => {
    const h = controlledGoalHarness({ runTurn: async () => ({ status: 'complete', summary: '完成', evidence: ['证据'] }) })
    await h.controller.start('s', '旧目标')
    const callback = [...h.scheduled.values()][0]!.callback
    await h.dispatch()
    callback()
    await h.flush()
    expect(h.controller.get('s')?.iteration).toBe(1)
    const previousRevision = h.controller.get('s')?.revision ?? 0
    const next = await h.controller.start('s', '新目标')
    expect(next.revision).toBeGreaterThan(previousRevision)
  })

  test('同一 scheduler callback 重复触发不启动并发 owner', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    let count = 0
    const h = controlledGoalHarness({ runTurn: () => { count++; return turn.promise } })
    await h.controller.start('s', '目标')
    const callback = [...h.scheduled.values()][0]!.callback
    await h.dispatch()
    callback()
    await h.flush()
    expect(count).toBe(1)
    expect(h.controller.get('s')?.iteration).toBe(1)
    turn.resolve({ status: 'complete', summary: '完成', evidence: ['证据'] })
    await h.flush()
  })

  test('hydrate 清除残留owner，恢复后可再次暂停与恢复', async () => {
    const h = controlledGoalHarness()
    h.controller.restore([{ ...createGoalState('s', '目标'), status: 'stopped', activeRunId: 'crashed-owner' }])
    expect(h.controller.get('s')?.activeRunId).toBeUndefined()
    await h.controller.resume('s')
    await h.dispatch()
    const deadline = [...h.deadlines.values()][0]?.callback
    await h.controller.pause('s')
    await h.controller.resume('s')
    deadline?.()
    await h.flush()
    expect(h.controller.get('s')?.status).toBe('active')
  })

  test('token 预算轮结算耗尽，扩充后恢复与最后轮完成优先', async () => {
    const usage = { inputTokens: 8, outputTokens: 2, totalTokens: 10 }
    let complete = false
    const h = controlledGoalHarness({ runTurn: async () => ({ status: complete ? 'complete' : 'continue', summary: '完成本轮检查', evidence: ['测试结果'], usage }) })
    h.controller.restore([{ ...createGoalState('s', '目标'), status: 'paused', limits: { ...createGoalState('s', '目标').limits, maxTokens: 10 } }])
    await h.controller.resume('s')
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'budget_limited', usage })
    await expect(h.controller.resume('s')).rejects.toThrow('预算')
    h.controller.update('s', { limits: { maxTokens: 20 } })
    complete = true
    await h.controller.resume('s')
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'completed', usage: { totalTokens: 20 } })
  })

  test('stop迟到返回在clear/新start后不发布旧状态', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const stop = deferred<void>()
    const h = controlledGoalHarness({ runTurn: () => turn.promise, stopTurn: () => stop.promise })
    await h.controller.start('s', '旧目标')
    await h.dispatch()
    const stopping = h.controller.stop('s')
    for (const timer of [...h.deadlines.values()]) if (timer.delay === 5000) timer.callback()
    await stopping
    turn.resolve({ status: 'continue', summary: '迟到', evidence: [] })
    await h.flush()
    h.controller.clear('s')
    const replacement = await h.controller.start('s', '新目标')
    const count = h.events.length
    stop.resolve()
    await h.flush()
    expect(h.events).toHaveLength(count)
    expect(h.controller.get('s')?.id).toBe(replacement.id)
  })

  test('时长预算不在轮中砍断：本轮自然结束后才转 budget_limited', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const stopped: Array<string | undefined> = []
    const h = controlledGoalHarness({ runTurn: () => turn.promise, stopTurn: async (_sessionId, runId) => { stopped.push(runId) } })
    h.controller.restore([{ ...createGoalState('s', '目标', 1000, { maxDurationMs: 60_000, maxConsecutiveFailures: 3 }), status: 'paused' }])
    await h.controller.resume('s')
    await h.dispatch()
    h.advance(120_000)
    await h.flush()
    expect(h.deadlines.size).toBe(0)
    expect(stopped).toEqual([])
    expect(h.controller.get('s')?.status).toBe('active')
    turn.resolve({ status: 'continue', summary: '收尾', evidence: [] })
    await h.flush()
    expect(h.controller.get('s')).toMatchObject({ status: 'budget_limited', elapsedMs: 120_000 })
    expect(h.scheduled.size).toBe(0)
  })

  test('旧 runtime callback 和旧 scheduler callback 不能污染替换后的 Goal', async () => {
    let report!: (id: string) => void
    const h = controlledGoalHarness({ runTurn: async ({ onRuntimeSessionId }) => { report = onRuntimeSessionId; return { status: 'complete', summary: '完成', evidence: ['证据'] } } })
    await h.controller.start('s', '旧目标')
    const oldCallback = [...h.scheduled.values()][0]!.callback
    await h.dispatch()
    const replacement = await h.controller.start('s', '新目标')
    report('stale-runtime')
    oldCallback()
    await h.flush()
    expect(h.controller.get('s')?.id).toBe(replacement.id)
    expect(h.controller.get('s')?.iteration).toBe(0)
    expect(h.controller.get('s')?.runtimeSessionId).toBeUndefined()
  })
})


describe('GoalController v2 生命周期审计', () => {
  test('创建、blocked、恢复和完成有唯一有序事件，元数据 patch 不追加转移', async () => {
    let complete = false
    const h = controlledGoalHarness({ runTurn: async () => complete ? { status: 'complete', summary: '验收通过', evidence: ['测试通过'] } : { status: 'blocked', summary: '需要凭据', evidence: [] } })
    await h.controller.start('s', '目标')
    await h.dispatch()
    const blocked = h.controller.get('s')!
    expect(blocked.lifecycle?.map((event) => event.to)).toEqual(['active', 'blocked'])
    expect(blocked.lifecycle?.at(-1)).toMatchObject({ reason: 'blocked', detail: '需要凭据', runId: expect.any(String) })
    h.controller.patch('s', { blockedTodoId: 'todo' })
    expect(h.controller.get('s')?.lifecycle).toEqual(blocked.lifecycle)
    complete = true
    await h.controller.resume('s')
    await h.dispatch()
    const final = h.controller.get('s')!
    expect(final.lifecycle?.map((event) => event.to)).toEqual(['active', 'blocked', 'active', 'completed'])
    expect(final).toMatchObject({ reasonCode: 'completed', reasonDetail: '验收通过' })
    const events = final.lifecycle!
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    expect(events.every((event, index) => event.goalId === final.id && event.sessionId === 's' && (!index || event.revision > events[index - 1]!.revision))).toBe(true)
    const cleared = h.controller.clear('s')
    expect(cleared.lifecycle?.at(-1)).toMatchObject({ from: 'completed', to: 'cleared', reason: 'cleared' })
    expect(h.controller.get('s')).toBeUndefined()
  })

  test('重启恢复只追加一次暂停，hydrate 不投影副作用，保留崩溃 runId', () => {
    const h = controlledGoalHarness()
    h.controller.restore([{ ...createGoalState('s', '目标', 1000), activeRunId: 'crashed' }])
    const paused = h.controller.get('s')!
    expect(paused).toMatchObject({ status: 'paused', reasonCode: 'app_restart', activeRunId: undefined })
    expect(paused.lifecycle?.at(-1)).toMatchObject({ from: 'active', to: 'paused', reason: 'app_restart', runId: 'crashed' })
    h.controller.restore([paused])
    expect(h.controller.get('s')?.lifecycle).toEqual(paused.lifecycle)
    expect(h.events).toEqual([])
  })

  test('迟到 runtime/scheduler 不增加新目标审计事件，版本跨替换单调', async () => {
    let report!: (id: string) => void
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const h = controlledGoalHarness({ runTurn: ({ onRuntimeSessionId }) => { report = onRuntimeSessionId; return turn.promise } })
    await h.controller.start('s', '旧目标')
    const scheduler = [...h.scheduled.values()][0]!.callback
    await h.dispatch()
    await h.controller.stop('s')
    const stoppedEvents = h.controller.get('s')!.lifecycle!
    turn.resolve({ status: 'complete', summary: '迟到完成', evidence: ['证据'] })
    await h.flush()
    expect(h.controller.get('s')?.lifecycle).toEqual(stoppedEvents)
    const cleared = h.controller.clear('s')
    const next = await h.controller.start('s', '新目标')
    scheduler(); report('迟到 runtime')
    await h.flush()
    expect(h.controller.get('s')?.lifecycle).toEqual(next.lifecycle)
    expect(next.lifecycle?.[0]?.revision).toBeGreaterThan(cleared.revision!)
    expect(next.lifecycle).toHaveLength(1)
  })

  test('重复 stop/pause 不追加事件，清除前归档失败保留 live Goal', async () => {
    let denyArchive = true
    const h = controlledGoalHarness({ onBeforeClear: () => { if (denyArchive) throw new Error('归档失败') } })
    await h.controller.start('s', '目标')
    await h.controller.pause('s')
    const paused = h.controller.get('s')!
    await h.controller.pause('s')
    expect(h.controller.get('s')).toBe(paused)
    await h.controller.stop('s')
    const stopped = h.controller.get('s')!
    await h.controller.stop('s')
    expect(h.controller.get('s')).toBe(stopped)
    expect(() => h.controller.clear('s')).toThrow('归档失败')
    expect(h.controller.get('s')).toBe(stopped)
    denyArchive = false
    h.controller.clear('s')
    expect(h.controller.get('s')).toBeUndefined()
  })

  test('预算拒绝恢复不会重复审计，编辑预算后恢复记录真实转移', async () => {
    const h = controlledGoalHarness()
    h.controller.restore([{ ...createGoalState('s', '目标', 1000, { maxIterations: 20, maxConsecutiveFailures: 3 }), status: 'paused', iteration: 20 }])
    await expect(h.controller.resume('s')).rejects.toThrow('预算')
    const events = h.controller.get('s')!.lifecycle!
    expect(events.at(-1)).toMatchObject({ from: 'paused', to: 'budget_limited', reason: 'budget_limited' })
    await expect(h.controller.resume('s')).rejects.toThrow('预算')
    expect(h.controller.get('s')?.lifecycle).toEqual(events)
    h.controller.update('s', { limits: { maxIterations: 21 } })
    await h.controller.resume('s')
    expect(h.controller.get('s')?.lifecycle?.at(-1)).toMatchObject({ from: 'budget_limited', to: 'active', reason: 'resumed' })
  })

  test('可重试错误按 1/5/15 分钟退避，不占轮次和无进展次数，第 4 次失败后暂停', async () => {
    const h = controlledGoalHarness({
      random: () => 0.5,
      runTurn: async () => ({ status: 'continue', outcome: 'failed', errorKind: 'retryable', summary: '网络错误', error: 'ECONNRESET', evidence: [] }),
    })
    await h.controller.start('s', '目标')
    const delays: number[] = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.dispatch()
      expect(h.controller.get('s')).toMatchObject({ status: 'active', iteration: 0, consecutiveFailures: 0, retry: { attempt, error: 'ECONNRESET' } })
      delays.push([...h.scheduled.values()][0]!.delay)
    }
    expect(delays).toEqual([60_000, 300_000, 900_000])
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'paused', reasonCode: 'retry_exhausted', reasonDetail: 'ECONNRESET', retry: undefined })
    expect(h.scheduled.size).toBe(0)
  })

  test('重试后成功一轮会清空重试状态', async () => {
    let fail = true
    const h = controlledGoalHarness({
      runTurn: async () => fail
        ? { status: 'continue', outcome: 'failed', errorKind: 'retryable', summary: '限流', error: '429', evidence: [] }
        : { status: 'continue', summary: '推进', evidence: [] },
    })
    await h.controller.start('s', '目标')
    await h.dispatch()
    fail = false
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'active', iteration: 1, retry: undefined })
  })

  test('不可恢复错误直接暂停并保留错误原因', async () => {
    const h = controlledGoalHarness({ runTurn: async () => ({ status: 'continue', outcome: 'failed', errorKind: 'fatal', summary: '鉴权失败', error: '401 invalid api key', evidence: [] }) })
    await h.controller.start('s', '目标')
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'paused', reasonCode: 'run_error', reasonDetail: '401 invalid api key', iteration: 0, consecutiveFailures: 0 })
  })

  test('用户中断只暂停，原因码 user_interrupt', async () => {
    const turn = deferred<import('@profer/shared').AgentGoalIterationResult>()
    const h = controlledGoalHarness({ runTurn: () => turn.promise, stopTurn: async () => { turn.resolve({ status: 'continue', outcome: 'stopped', summary: '中断', evidence: [] }) } })
    await h.controller.start('s', '目标')
    await h.dispatch()
    await h.controller.pauseForInterrupt('s')
    await h.flush()
    expect(h.controller.get('s')).toMatchObject({ status: 'paused', reasonCode: 'user_interrupt', activeRunId: undefined })
  })

  test('等待计划模式时保持 active 但不运行、不计轮次，切换后自动继续', async () => {
    let waiting: 'plan_mode' | undefined = 'plan_mode'
    let runs = 0
    const h = controlledGoalHarness({ waitingReason: () => waiting, runTurn: async () => { runs++; return { status: 'complete', summary: '完成', evidence: ['测试通过'] } } })
    await h.controller.start('s', '目标')
    await h.dispatch()
    expect(h.controller.get('s')).toMatchObject({ status: 'active', iteration: 0, waiting: 'plan_mode' })
    expect(runs).toBe(0)
    waiting = undefined
    await h.dispatch()
    expect(runs).toBe(1)
    expect(h.controller.get('s')).toMatchObject({ status: 'completed', waiting: undefined })
  })
})
