import { describe, test, expect } from 'bun:test'

describe('Pi adapter 模块加载冒烟（SDK 0.84.2）', () => {
  test('pi-agent-adapter 模块可加载（import 链在 0.84.2 下正常）', async () => {
    const mod = await import('./pi-agent-adapter')
    expect(mod).toBeDefined()
    // 关键导出应存在
    expect(typeof mod.PiAgentAdapter).toBe('function')
    expect(typeof mod.cleanupPiRuntimeResources).toBe('function')
    console.log('[冒烟] PiAgentAdapter 类与关键导出加载成功')
  })

  test('pi-retry-control 运行时映射在 0.84.2 事件下工作', async () => {
    const rc = await import('./pi-retry-control')
    const start = rc.mapPiNativeRetryEvent(
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1500, errorMessage: 'x' },
      Date.now(),
    )
    expect(start[0]?.status).toBe('starting')
    const attemptStart = rc.mapPiNativeRetryEvent(
      { type: 'auto_retry_attempt_start', attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'y' },
      Date.now(),
    )
    expect(attemptStart[0]?.status).toBe('attempt')
    const cancelled = rc.mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: false, outcome: 'cancelled', attempt: 3, maxAttempts: 3, delayMs: 0 },
      Date.now(),
    )
    expect(cancelled[0]?.status).toBe('cleared')
    console.log('[冒烟] retry 事件映射（start/attempt_start/cancelled）运行时工作正常')
  })
})
