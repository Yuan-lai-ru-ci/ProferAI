import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta } from '@profer/shared'
import {
  agentSessionsAtom,
  memoryUnviewedCompletedSessionIdsAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { manualReadConfirmEnabledAtom } from '@/atoms/agent-unread-settings'
import { applyUnreadModeTransition } from './agent-unread-transition'

/**
 * 开关切换的未读迁移（`requirements.md` §6 U-1 / `design.md` §10 单测第 3 组）。
 *
 * 主会话已定取舍：**关 → 开时把关闭态期间产生的内存未读补写为持久化未读**，避免开启瞬间
 * 吞掉未读；**开 → 关时把持久化未读回填内存集合，并把开启态期间已确认已读的陈旧内存 id 剔除**
 * （双向收敛，验收缺陷 F-1）。两向都不丢任何仍为未读的会话。
 *
 * 调用时序按真实实现：`manualReadConfirmEnabledAtom` 已经写成新值（`to`），`from` 是旧值。
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

describe('关 → 开：补写持久化未读，开启瞬间不丢未读', () => {
  test('Given 关闭态有内存未读 When 开启开关 Then 逐个补写成持久化未读且未读仍可见', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a', 'b']))

    // 开关已经写成新值（manual），迁移随后执行。
    store.set(manualReadConfirmEnabledAtom, true)
    const plan = await applyUnreadModeTransition({
      from: 'auto',
      to: 'manual',
      get: store.get,
      set: store.set,
    })

    expect(plan.persistUnreadIds.sort()).toEqual(['a', 'b'])
    expect(persistedWrites.sort()).toEqual(['a', 'b'])
    // 补写结果的乐观刷新让开启态的派生读立刻看到未读。
    expect([...store.get(unviewedCompletedSessionIdsAtom)].sort()).toEqual(['a', 'b'])
  })

  test('Given 内存未读已在持久化字段里 When 开启开关 Then 不重复补写', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a']))
    store.set(agentSessionsAtom, [session('a', true)])

    store.set(manualReadConfirmEnabledAtom, true)
    const plan = await applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })

    expect(plan.persistUnreadIds).toEqual([])
    expect(persistedWrites).toEqual([])
  })
})

describe('开 → 关：回填内存集合，关闭态仍能看到未读', () => {
  test('Given 开启态有持久化未读 When 关闭开关 Then 回填内存集合并保持可见', async () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('a', true), session('b', false)])
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['a'])

    store.set(manualReadConfirmEnabledAtom, false)
    const plan = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })

    expect(plan.seedMemoryUnreadIds).toEqual(['a'])
    expect(persistedWrites).toEqual([])
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['a'])
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['a'])
  })

  test('Given 内存集合已有该未读 When 关闭开关 Then 不重复回填（幂等）', async () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session('a', true)])
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a']))

    store.set(manualReadConfirmEnabledAtom, false)
    const plan = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })

    expect(plan.seedMemoryUnreadIds).toEqual([])
  })
})

describe('同态迁移不产生副作用', () => {
  test('Given 模式没变 When 执行迁移 Then 无写入、无回填', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a']))
    store.set(agentSessionsAtom, [session('b', true)])

    const plan = await applyUnreadModeTransition({ from: 'auto', to: 'auto', get: store.get, set: store.set })

    expect(plan).toEqual({ persistUnreadIds: [], seedMemoryUnreadIds: [], clearMemoryUnreadIds: [] })
    expect(persistedWrites).toEqual([])
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['a'])
  })
})
