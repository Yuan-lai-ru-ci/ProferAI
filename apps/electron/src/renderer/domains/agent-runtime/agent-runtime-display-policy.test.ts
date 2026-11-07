import { describe, expect, test } from 'bun:test'
import { countRunningDelegations, deriveAgentRuntimeDisplay } from './agent-runtime-display-policy'

const running = { running: true }
const assistant = (error = false) => ({ type: 'assistant', ...(error ? { error: { message: '断流' } } : {}) })

describe('Agent 活跃运行显示投影', () => {
  test('委派计数只包含当前父会话的运行中委派，不混入探索分支或普通子会话', () => {
    expect(countRunningDelegations([
      { parentSessionId: 'parent', sourceDelegationId: 'd1', delegationStatus: 'running' },
      { parentSessionId: 'parent', sourceDelegationId: 'd2', delegationStatus: 'completed' },
      { parentSessionId: 'parent', delegationStatus: 'running' },
      { parentSessionId: 'other', sourceDelegationId: 'd3', delegationStatus: 'running' },
      { parentSessionId: 'parent', sourceDelegationId: 'explore', explorationParentSessionId: 'parent', delegationStatus: 'running' },
    ], 'parent')).toBe(1)
  })

  test('正常运行保持计时指示，输出错误保留真实活跃态', () => {
    expect(deriveAgentRuntimeDisplay(running).kind).toBe('running')
    const interrupted = deriveAgentRuntimeDisplay({ ...running, streamError: '上游断流' })
    expect(interrupted).toMatchObject({ kind: 'interrupted', active: true, showRunningIndicator: false })
    expect(interrupted.label).toBe('输出异常，运行尚未结束')
  })

  test('停止优先于重试、错误与压缩，不显示普通运行计时', () => {
    expect(deriveAgentRuntimeDisplay({ ...running, stopping: true, compactInFlight: true, retrying: true, streamError: '错误' }))
      .toMatchObject({ kind: 'stopping', active: true, showRunningIndicator: false, showRetry: false })
  })

  test('压缩期间与手动压缩 run 的收尾窗口不重复显示运行、后台或协作等待行', () => {
    for (const flag of [{ isCompacting: true }, { compactInFlight: true }]) {
      expect(deriveAgentRuntimeDisplay({ ...running, ...flag, backgroundWaiting: true, runningDelegationCount: 2 }))
        .toMatchObject({ kind: 'none', active: true, showRunningIndicator: false, showRetry: false })
    }
  })

  test('自动压缩结束后本轮继续执行，运行指示必须恢复', () => {
    // 自动压缩（阈值/溢出）只置 isCompacting，compact_boundary 到达后同一轮会继续跑：
    // 不能把「压缩结束」当成「run 结束」，否则长会话会长时间看不到运行指示。
    expect(deriveAgentRuntimeDisplay({ ...running, isCompacting: true })).toMatchObject({ kind: 'none', active: true })
    expect(deriveAgentRuntimeDisplay({ ...running, isCompacting: false, compactInFlight: false }))
      .toMatchObject({ kind: 'running', active: true, showRunningIndicator: true })
  })

  test('正在重试时取代普通计时和旧错误说明；失败记录不解除运行锁', () => {
    expect(deriveAgentRuntimeDisplay({ ...running, retrying: true, liveMessages: [assistant(true)] }))
      .toMatchObject({ kind: 'retrying', showRetry: true, showRunningIndicator: false, active: true })
    expect(deriveAgentRuntimeDisplay({ ...running, retrying: true, retryFailed: true }))
      .toMatchObject({ kind: 'interrupted', showRetry: true, active: true })
  })

  test('最近一次助手输出决定当前异常，旧错误不遮住已经恢复的新输出', () => {
    expect(deriveAgentRuntimeDisplay({ ...running, liveMessages: [assistant(true), assistant()] }).kind).toBe('running')
    expect(deriveAgentRuntimeDisplay({ ...running, liveMessages: [assistant(), assistant(true), { type: 'user' }] }).kind).toBe('interrupted')
  })

  test('没有实时消息时不从历史错误推断运行失败', () => {
    expect(deriveAgentRuntimeDisplay({ ...running, liveMessages: [] }).kind).toBe('running')
    expect(deriveAgentRuntimeDisplay({ running: false, streamError: '上轮错误', liveMessages: [assistant(true)] }))
      .toMatchObject({ kind: 'none', active: false, showRunningIndicator: false })
  })

  test('后台与协作等待合成一条状态，空会话也保持活跃显示', () => {
    expect(deriveAgentRuntimeDisplay({ running: false, backgroundWaiting: true }))
      .toMatchObject({ kind: 'background', active: true, label: '本轮已答复，后台任务仍在执行' })
    const combined = deriveAgentRuntimeDisplay({ running: false, backgroundWaiting: true, runningDelegationCount: 2 })
    expect(combined.kind).toBe('background')
    expect(combined.label).toContain('2 个协作子会话')
    expect(deriveAgentRuntimeDisplay({ running: false, runningDelegationCount: 2 }))
      .toMatchObject({ kind: 'delegation', active: true })
  })

  test('活跃轮次优先于子会话等待，不显示第二条等待指示', () => {
    expect(deriveAgentRuntimeDisplay({ ...running, runningDelegationCount: 3 })).toMatchObject({ kind: 'running', active: true })
  })

  test('可见等待数忽略非有限、负值并取整数', () => {
    for (const count of [-1, NaN, Infinity]) {
      expect(deriveAgentRuntimeDisplay({ running: false, runningDelegationCount: count }).kind).toBe('none')
    }
    expect(deriveAgentRuntimeDisplay({ running: false, runningDelegationCount: 2.9 }).label).toContain('2 个')
  })

  test('停止占位即使没有 running 也保持活跃，不渲染空欢迎页', () => {
    expect(deriveAgentRuntimeDisplay({ running: false, stopping: true })).toMatchObject({ kind: 'stopping', active: true })
  })
})
