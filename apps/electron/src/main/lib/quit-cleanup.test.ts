import { describe, expect, test } from 'bun:test'
import { awaitQuitCleanup, resolveQuitCleanupTimeoutMs } from './quit-cleanup'

/**
 * 退出清理的契约：无论清理任务多慢、怎么失败，调用方都必须在预算内拿到结论，
 * 因为「继续退出」是唯一可接受的默认行为。
 */
describe('退出清理预算', () => {
  test('清理正常完成时返回 completed 并记录耗时', async () => {
    const result = await awaitQuitCleanup(Promise.resolve(), 1_000)
    expect(result.outcome).toBe('completed')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  test('清理失败时返回 failed 并带上错误信息，而不是把异常抛给退出流程', async () => {
    const result = await awaitQuitCleanup(Promise.reject(new Error('frpc 未退出')), 1_000)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('frpc 未退出')
  })

  test('清理挂死时按预算收敛成 timeout，而不是一起挂死', async () => {
    const startedAt = Date.now()
    const result = await awaitQuitCleanup(new Promise(() => {}), 80)
    expect(result.outcome).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test('预算可由环境变量覆盖，非法值回落默认 3s', () => {
    expect(resolveQuitCleanupTimeoutMs('250')).toBe(250)
    expect(resolveQuitCleanupTimeoutMs('0')).toBe(3_000)
    expect(resolveQuitCleanupTimeoutMs('abc')).toBe(3_000)
    expect(resolveQuitCleanupTimeoutMs(undefined)).toBe(3_000)
  })
})
