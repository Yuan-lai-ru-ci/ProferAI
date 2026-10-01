import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta } from '@profer/shared'
import {
  agentSessionsAtom,
  memoryUnviewedCompletedSessionIdsAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { manualReadConfirmEnabledAtom } from '@/atoms/agent-unread-settings'
import { planModeTransition } from './agent-unread-gate'
import { applyUnreadModeTransition } from './agent-unread-transition'

/**
 * F-1 回归（验收缺陷修复）：开关「开 → 关」必须**双向收敛**。
 *
 * 缺陷是：开启态里已「确认已读」的会话，切回关闭态后绿标复活——因为迁移只做回填（只增），
 * 而内存集合在开启态期间是空转的，里面留着的旧 id 无人剔除。
 *
 * 覆盖点（自写用例，与验收探针思路相同但独立成文）：
 * 1. 纯函数：开 → 关把「会话列表里明确为已读」的陈旧内存 id 列进 `clearMemoryUnreadIds`；
 * 2. 纯函数：会话列表里**不存在**的未知 id 一律保留（不追溯清理）；
 * 3. 纯函数：仍为未读的持久化 id 只回填、不被剔除；关 → 开方向不受剔除清单影响；
 * 4. 真实流程（store + stub `window.electronAPI`）：关闭态内存未读 → 开 → 开启态确认已读 → 关
 *    ⇒ 关闭态读到的未读集合为空（绿标不复活），且期间未读一个都没丢。
 */

const previousWindow = (globalThis as { window?: unknown }).window
const persistedWrites: string[] = []

function stubElectronApi(): void {
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      setAgentCompletionState: async (id: string): Promise<AgentSessionMeta> => {
        persistedWrites.push(id)
        return { id, title: id, createdAt: 1, updatedAt: 1, completedButUnconfirmed: true } as AgentSessionMeta
      },
    },
  }
}

function session(id: string, completedButUnconfirmed?: boolean): AgentSessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...(completedButUnconfirmed === undefined ? {} : { completedButUnconfirmed }),
  } as AgentSessionMeta
}

beforeEach(() => {
  persistedWrites.length = 0
  stubElectronApi()
})

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = previousWindow
})

describe('planModeTransition：开 → 关的双向收敛（F-1）', () => {
  test('Given 已确认已读的会话仍有陈旧内存副本 When 切回关闭态 Then 它被列进剔除清单', () => {
    expect(planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: ['stale', 'fresh'],
      persistedUnreadIds: ['persisted-only'],
      confirmedReadIds: ['stale'],
    })).toEqual({
      persistUnreadIds: [],
      seedMemoryUnreadIds: ['persisted-only'],
      clearMemoryUnreadIds: ['stale'],
    })
  })

  test('Given 内存 id 不在会话列表里 When 切回关闭态 Then 未知 id 一律保留（不追溯清理）', () => {
    expect(planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: ['ghost'],
      persistedUnreadIds: [],
      confirmedReadIds: ['known-and-read'],
    }).clearMemoryUnreadIds).toEqual([])
  })

  test('Given 持久化仍是未读 When 切回关闭态 Then 只回填不剔除（U-1 不丢未读）', () => {
    expect(planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: [],
      persistedUnreadIds: ['still-unread', 'stale-but-persisted'],
      confirmedReadIds: ['another-read'],
    })).toEqual({
      persistUnreadIds: [],
      seedMemoryUnreadIds: ['still-unread', 'stale-but-persisted'],
      clearMemoryUnreadIds: [],
    })
  })

  test('Given 同 id 在内存里重复 When 剔除 Then 去重后只出现一次', () => {
    expect(planModeTransition({
      from: 'manual',
      to: 'auto',
      memoryUnreadIds: ['stale', 'stale'],
      persistedUnreadIds: [],
      confirmedReadIds: ['stale'],
    }).clearMemoryUnreadIds).toEqual(['stale'])
  })

  test('Given 关 → 开 When 传入剔除清单 Then 不影响补写（关闭态内存未读一律补写）', () => {
    expect(planModeTransition({
      from: 'auto',
      to: 'manual',
      memoryUnreadIds: ['a'],
      persistedUnreadIds: [],
      confirmedReadIds: ['a'],
    })).toEqual({
      persistUnreadIds: ['a'],
      seedMemoryUnreadIds: [],
      clearMemoryUnreadIds: [],
    })
  })

  test('Given 模式没变 When 迁移 Then 三项都为空', () => {
    for (const mode of ['auto', 'manual'] as const) {
      expect(planModeTransition({
        from: mode,
        to: mode,
        memoryUnreadIds: ['a'],
        persistedUnreadIds: ['b'],
        confirmedReadIds: ['a'],
      })).toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
    }
  })
})

describe('applyUnreadModeTransition：真实流程的收敛（F-1 复现用例）', () => {
  test('Given 开启态确认已读 When 切回关闭态 Then 绿标不得复活', async () => {
    const store = createStore()
    // ① 关闭态：完成类未读只进内存集合（关闭态主进程不写持久化字段）
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a']))
    store.set(agentSessionsAtom, [session('a', false)])

    // ② 开启开关：内存未读补写成持久化未读（未读不丢）
    store.set(manualReadConfirmEnabledAtom, true)
    const toManual = await applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })
    expect(toManual.persistUnreadIds).toEqual(['a'])
    expect(persistedWrites).toEqual(['a'])
    // 乐观刷新 / projection 让列表看到持久化未读（开启态读＝派生）
    store.set(agentSessionsAtom, [session('a', true)])
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['a'])

    // ③ 开启态里用户确认已读：持久化字段清掉、内存集合的写入被模式守卫静默丢弃（陈旧副本仍在）
    store.set(agentSessionsAtom, [session('a', false)])
    store.set(unviewedCompletedSessionIdsAtom, new Set())
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['a'])
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual([])

    // ④ 关闭开关：陈旧副本必须被剔除，关闭态不得再显示该会话未读
    store.set(manualReadConfirmEnabledAtom, false)
    const toAuto = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })
    expect(toAuto.clearMemoryUnreadIds).toEqual(['a'])
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual([])
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual([])
  })

  test('Given 开启态仍有持久化未读 When 切回关闭态 Then 只回填、不剔除（未读一个不丢）', async () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('unread', true), session('read', false)])
    // 不在会话列表里的历史 id（例如列表还没拉回来）一律保留，不追溯清理。
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['unknown-id']))

    store.set(manualReadConfirmEnabledAtom, false)
    const plan = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })

    expect(plan.seedMemoryUnreadIds).toEqual(['unread'])
    expect(plan.clearMemoryUnreadIds).toEqual([])
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)].sort()).toEqual(['unknown-id', 'unread'])
  })

  test('Given 关闭态内存未读与持久化未读重合 When 关闭开关 Then 不重复回填（幂等）', async () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session('a', true)])
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a']))

    store.set(manualReadConfirmEnabledAtom, false)
    const plan = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })

    expect(plan).toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['a'])
  })
})
