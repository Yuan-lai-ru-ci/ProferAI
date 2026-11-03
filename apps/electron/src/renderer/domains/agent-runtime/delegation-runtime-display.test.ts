import { describe, expect, test } from 'bun:test'
import {
  DELEGATION_RUNNING_STALE_MS,
  formatDelegationElapsed,
  resolveDelegationConversationRunState,
  resolveDelegationRuntimeDisplay,
} from './delegation-runtime-display'

const NOW = 1_800_000_000_000

const base = {
  parentSessionId: 'parent',
  sourceDelegationId: 'delegation',
  sessionUpdatedAt: NOW - 1_000,
  now: NOW,
}

describe('委派子会话运行状态显示', () => {
  test('Given 普通会话或探索分支 When 解析 Then 不显示状态条', () => {
    expect(resolveDelegationRuntimeDisplay({ ...base, parentSessionId: undefined, liveRunning: true }).visible).toBe(false)
    expect(resolveDelegationRuntimeDisplay({ ...base, sourceDelegationId: undefined, liveRunning: true }).visible).toBe(false)
  })

  test('Given 实时流在运行 When 解析 Then 用实时起点驱动计时', () => {
    const display = resolveDelegationRuntimeDisplay({
      ...base,
      liveRunning: true,
      liveStartedAt: NOW - 65_000,
      delegationStatus: 'running',
    })
    expect(display).toMatchObject({ visible: true, phase: 'running', live: true, startedAt: NOW - 65_000 })
  })

  test('Given 持久化 running 但无实时状态 When 解析 Then 无回退起点时不臆造计时起点', () => {
    const display = resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: 'running' })
    expect(display).toMatchObject({ visible: true, phase: 'running', live: false })
    expect(display.startedAt).toBeUndefined()
  })

  test('Given 持久化 running 但无实时状态 When 解析 Then 用最近一条人类输入作为本轮起点', () => {
    const display = resolveDelegationRuntimeDisplay({
      ...base,
      liveRunning: false,
      delegationStatus: 'running',
      fallbackStartedAt: NOW - 30_000,
    })
    expect(display).toMatchObject({ visible: true, phase: 'running', live: false, startedAt: NOW - 30_000 })
  })

  test('Given 持久化 running 但长期无活动 When 解析 Then 不再伪装成运行中', () => {
    const display = resolveDelegationRuntimeDisplay({
      ...base,
      liveRunning: false,
      delegationStatus: 'running',
      sessionUpdatedAt: NOW - DELEGATION_RUNNING_STALE_MS - 1,
    })
    expect(display).toMatchObject({ visible: true, phase: 'unknown', live: false })
    expect(display.startedAt).toBeUndefined()
  })

  test('Given 终态 When 解析 Then 显示状态但不再给运行计时', () => {
    for (const [status, label] of [
      ['completed', '子代理已完成'],
      ['failed', '子代理执行失败'],
      ['cancelled', '子代理已取消'],
      ['interrupted', '子代理已中断'],
    ] as const) {
      const display = resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: status })
      expect(display).toMatchObject({ visible: true, phase: status, label, live: false })
      expect(display.startedAt).toBeUndefined()
    }
  })

  test('Given 未知状态 When 解析 Then 不显示（不把普通子会话当成委派态）', () => {
    expect(resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: null }).visible).toBe(false)
  })

  test('耗时格式：一分钟内按秒，此后按 分:秒', () => {
    expect(formatDelegationElapsed(9_400)).toBe('9s')
    expect(formatDelegationElapsed(65_000)).toBe('1:05')
    expect(formatDelegationElapsed(-1)).toBe('0s')
  })

  test('Given independent 委派（无父会话、只有来源会话）When 解析 Then 仍然显示运行状态', () => {
    const display = resolveDelegationRuntimeDisplay({
      parentSessionId: undefined,
      sourceSessionId: 'source-session',
      sourceDelegationId: 'delegation',
      delegationStatus: 'running',
      liveRunning: false,
      fallbackStartedAt: NOW - 12_000,
      sessionUpdatedAt: NOW - 1_000,
      now: NOW,
    })
    expect(display).toMatchObject({ visible: true, phase: 'running', startedAt: NOW - 12_000 })
  })
})

describe('对话区运行态收敛', () => {
  const delegationRunning = resolveDelegationRuntimeDisplay({
    ...base,
    liveRunning: false,
    delegationStatus: 'running',
    fallbackStartedAt: NOW - 40_000,
  })

  test('Given 实时流在运行 When 解析 Then 直接用实时起点且不标记兜底', () => {
    expect(resolveDelegationConversationRunState({
      liveRunning: true,
      liveStartedAt: NOW - 5_000,
      delegation: delegationRunning,
    })).toEqual({ streaming: true, startedAt: NOW - 5_000, fromDelegationStatus: false })
  })

  test('Given 没有实时流但委派状态为 running When 解析 Then 仍视为运行中并给出回退起点', () => {
    // 这就是「子会话没有 runtime，过程区一直折叠」的兜底：不依赖实时流也能展开。
    expect(resolveDelegationConversationRunState({
      liveRunning: false,
      delegation: delegationRunning,
    })).toEqual({ streaming: true, startedAt: NOW - 40_000, fromDelegationStatus: true })
  })

  test('Given 委派已终态或普通会话 When 解析 Then 不伪造运行态', () => {
    const completed = resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: 'completed' })
    expect(resolveDelegationConversationRunState({ liveRunning: false, delegation: completed }))
      .toEqual({ streaming: false, startedAt: undefined, fromDelegationStatus: false })
    expect(resolveDelegationConversationRunState({ liveRunning: false, delegation: null }))
      .toEqual({ streaming: false, startedAt: undefined, fromDelegationStatus: false })
  })
})
