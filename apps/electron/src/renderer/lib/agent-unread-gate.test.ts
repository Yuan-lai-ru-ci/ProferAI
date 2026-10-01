import { describe, expect, test } from 'bun:test'
import { planModeTransition, planUnreadSeedOnInit, shouldAutoClearUnreadOnView } from './agent-unread-gate'

/**
 * 未读门控与开关迁移（`design.md` §10 单测第 3 组后半 / `requirements.md` §6 U-1）。
 *
 * 关 → 开只补写、开 → 关只回填 + 剔除「已确认已读」的陈旧内存 id（双向收敛，验收缺陷 F-1）：
 * 两个方向都不丢任何**仍为未读**的会话。
 */

describe('自动清除路径的门控', () => {
  test('Given 关闭态 When 判断是否自动清未读 Then 是（既有行为不变）', () => {
    expect(shouldAutoClearUnreadOnView('auto')).toBe(true)
  })

  test('Given 开启态 When 判断是否自动清未读 Then 否（打开/关闭标签页都不能吃掉未读）', () => {
    expect(shouldAutoClearUnreadOnView('manual')).toBe(false)
  })
})

describe('关 → 开：把关闭态期间的内存未读补写成持久化未读', () => {
  test('Given 内存有未读且持久化没有 Then 列出需要补写的 id，不回填内存', () => {
    expect(planModeTransition({
      from: 'auto',
      to: 'manual',
      memoryUnreadIds: ['a', 'b'],
      persistedUnreadIds: [],
    })).toEqual({ persistUnreadIds: ['a', 'b'], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
  })

  test('Given 部分已在持久化 Then 只补写差集', () => {
    expect(planModeTransition({
      from: 'auto',
      to: 'manual',
      memoryUnreadIds: ['a', 'b', 'c'],
      persistedUnreadIds: ['b'],
    })).toEqual({ persistUnreadIds: ['a', 'c'], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
  })

  test('Given 完全没有未读 Then 不产生任何写入', () => {
    expect(planModeTransition({ from: 'auto', to: 'manual', memoryUnreadIds: [], persistedUnreadIds: [] }))
      .toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
  })

  test('Given 内存集合里有重复 id Then 去重后只补写一次', () => {
    expect(planModeTransition({
      from: 'auto',
      to: 'manual',
      memoryUnreadIds: ['a', 'a'],
      persistedUnreadIds: [],
    }).persistUnreadIds).toEqual(['a'])
  })
})

describe('开 → 关：把持久化未读回填内存集合', () => {
  test('Given 持久化有未读且内存没有 Then 列出需要回填的 id，不补写持久化', () => {
    expect(planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: [],
      persistedUnreadIds: ['x'],
    })).toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: ['x'], clearMemoryUnreadIds: [] })
  })

  test('Given 部分已在内存 Then 只回填差集', () => {
    expect(planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: ['x'],
      persistedUnreadIds: ['x', 'y'],
    })).toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: ['y'], clearMemoryUnreadIds: [] })
  })
})

describe('同态切换与不丢未读', () => {
  test('Given 模式没变 Then 计划为空（幂等，重复点同一个开关值无副作用）', () => {
    for (const mode of ['auto', 'manual'] as const) {
      expect(planModeTransition({
        from: mode,
        to: mode,
        memoryUnreadIds: ['a'],
        persistedUnreadIds: ['b'],
      })).toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
    }
  })

  test('Given 两向切换 Then 仍为未读的 id 一个都不丢（只剔除已确认已读）', () => {
    const toManual = planModeTransition({
      from: 'auto',
      to: 'manual',
      memoryUnreadIds: ['a', 'b'],
      persistedUnreadIds: ['c'],
    })
    const toAuto = planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: ['a'],
      persistedUnreadIds: ['c', 'd'],
      // 没有会话被确认为已读 ⇒ 不开除任何内存 id（只增不删）。
      confirmedReadIds: [],
    })
    // 两个方向加起来覆盖「内存 ∪ 持久化」的全部 id，没有任何一个被丢掉。
    const covered = new Set([...toManual.persistUnreadIds, ...toAuto.seedMemoryUnreadIds, ...toAuto.clearMemoryUnreadIds])
    expect([...covered].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('初始化安全回填', () => {
  test('Given 关闭态启动且持久化有未读 Then 列出需要补进内存集合的 id', () => {
    expect(planUnreadSeedOnInit({ memoryUnreadIds: ['a'], persistedUnreadIds: ['a', 'b'] })).toEqual(['b'])
  })

  test('Given 内存集合已包含全部持久化未读 Then 回填为空（幂等）', () => {
    expect(planUnreadSeedOnInit({ memoryUnreadIds: ['a', 'b'], persistedUnreadIds: ['a', 'b'] })).toEqual([])
  })
})
