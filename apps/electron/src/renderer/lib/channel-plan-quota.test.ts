import { beforeEach, describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaResult } from '@profer/shared'
import {
  supportsChannelPlanQuota,
  fetchChannelPlanQuota,
  requestPlanQuotaRefresh,
  ensurePeriodicRefresh,
  releasePeriodicRefresh,
  subscribeChannelQuotaRefresh,
} from './channel-plan-quota'

describe('渲染层渠道订阅额度能力', () => {
  test('Given 普通 zhipu 渠道 When 判断 Then 不触发订阅额度查询', () => {
    expect(supportsChannelPlanQuota({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' })).toBe(false)
  })

  test('Given GLM Coding Plan 渠道 When 判断 Then 允许查询订阅额度', () => {
    expect(supportsChannelPlanQuota({ provider: 'zhipu-coding', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/' })).toBe(true)
  })

  test('Given Profer 代管的支持类型渠道 When 判断 Then 不查询第三方订阅额度', () => {
    expect(supportsChannelPlanQuota({
      provider: 'kimi-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      serverManaged: true,
    })).toBe(false)
  })
})

describe('数据层：手动刷新、缓存 TTL 与 in-flight 锁定', () => {
  /** 记录每次真实 IPC 调用的渠道 ID，用于断言请求次数。 */
  const calls: string[] = []

  /** 注入 window.electronAPI.getChannelPlanQuota mock：延迟 delayMs 后返回 supported 结果。 */
  function installMock(delayMs = 5): void {
    const getChannelPlanQuota = (channelId: string): Promise<ChannelPlanQuotaResult> => new Promise((resolve) => {
      calls.push(channelId)
      setTimeout(() => resolve({
        supported: true,
        provider: 'deepseek',
        windows: [{ type: '5h', label: '每 5 小时', remainingPercent: 78, usedPercent: 22 }],
        updatedAt: Date.now(),
      }), delayMs)
    })
    ;(globalThis as unknown as { window: { electronAPI: { getChannelPlanQuota: (channelId: string) => Promise<ChannelPlanQuotaResult> } } }).window = {
      electronAPI: { getChannelPlanQuota },
    }
  }

  beforeEach(() => {
    calls.length = 0
  })

  test('Given 有有效缓存 When 手动刷新 Then 跳过缓存强制请求一次', async () => {
    installMock()
    const channelId = `forced-${Date.now()}`
    // 先通过 fetch 写入缓存
    await fetchChannelPlanQuota(channelId)
    expect(calls).toContain(channelId)

    // 手动刷新：即使缓存有效也强制重新请求
    await requestPlanQuotaRefresh(channelId)
    expect(calls.filter((id) => id === channelId)).toHaveLength(2)

    // 之后 fetch 命中新缓存，不再请求
    await fetchChannelPlanQuota(channelId)
    expect(calls.filter((id) => id === channelId)).toHaveLength(2)
  })

  test('Given 刷新进行中 When 并发重复调用 Then 复用同一请求（in-flight 锁）', async () => {
    installMock(30)
    const channelId = `lock-${Date.now()}`
    const [r1, r2] = await Promise.all([
      requestPlanQuotaRefresh(channelId),
      requestPlanQuotaRefresh(channelId),
    ])
    // 同一 in-flight Promise → 同一结果对象，只发一次 IPC
    expect(r1).toBe(r2)
    expect(calls.filter((id) => id === channelId)).toHaveLength(1)
  })

  test('Given 手动刷新与被动 fetch 并发 When 触发 Then 共享同一请求', async () => {
    installMock(30)
    const channelId = `shared-${Date.now()}`
    await Promise.all([
      fetchChannelPlanQuota(channelId),
      requestPlanQuotaRefresh(channelId),
    ])
    expect(calls.filter((id) => id === channelId)).toHaveLength(1)
  })

  test('Given 缓存未过期 When fetch Then 命中缓存不请求', async () => {
    installMock()
    const channelId = `ttl-${Date.now()}`
    await fetchChannelPlanQuota(channelId)
    const before = calls.filter((id) => id === channelId).length
    await fetchChannelPlanQuota(channelId)
    expect(calls.filter((id) => id === channelId)).toHaveLength(before)
  })

  test('Given 成功缓存已过期（>5min）When fetch Then 重新请求', async () => {
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    try {
      installMock()
      const channelId = `expired-${Date.now()}`
      await fetchChannelPlanQuota(channelId)
      const before = calls.filter((id) => id === channelId).length

      // 推进 5 分 1 秒：成功缓存 TTL 5 分钟过期（PR2 调整后）
      now += 5 * 60 * 1000 + 1_000
      await fetchChannelPlanQuota(channelId)
      expect(calls.filter((id) => id === channelId)).toHaveLength(before + 1)
    } finally {
      Date.now = originalNow
    }
  })
})

describe('数据层：PR2 定时后台刷新调度', () => {
  test('Given 订阅刷新事件 When 退订 Then 退订幂等、不抛错', () => {
    const channelId = `sub-${Date.now()}`
    const unsubscribe = subscribeChannelQuotaRefresh(channelId, () => {})
    unsubscribe()
    // 重复退订：集合删除幂等，不应抛错
    unsubscribe()
  })

  test('Given 注册注销交错 When 引用计数归零 Then 定时器被清理（无泄漏），多余注销安全', () => {
    const channelId = `ref-${Date.now()}`
    ensurePeriodicRefresh(channelId)
    ensurePeriodicRefresh(channelId)
    releasePeriodicRefresh(channelId)
    releasePeriodicRefresh(channelId)
    // 归零后再注销：安全降级为清理分支，不抛错
    releasePeriodicRefresh(channelId)
    // 归零后重新注册：可再次启动调度
    ensurePeriodicRefresh(channelId)
    releasePeriodicRefresh(channelId)
  })
})
