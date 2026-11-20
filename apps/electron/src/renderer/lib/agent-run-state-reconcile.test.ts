import { describe, expect, test } from 'bun:test'
import { shouldClearStaleRunState } from './agent-run-state-reconcile'

const base = { running: true, stopping: false, coreActive: false }

describe('校正残留运行态', () => {
  test('内核没在跑且界面显示运行中 → 收掉', () => {
    expect(shouldClearStaleRunState(base)).toBe(true)
  })

  test('内核说确实在跑 → 不动', () => {
    expect(shouldClearStaleRunState({ ...base, coreActive: true })).toBe(false)
  })

  test('正在停止 → 交给停止流程收敛', () => {
    expect(shouldClearStaleRunState({ ...base, stopping: true })).toBe(false)
  })

  test('界面本来就不在运行 → 无需处理', () => {
    expect(shouldClearStaleRunState({ ...base, running: false })).toBe(false)
  })
})
