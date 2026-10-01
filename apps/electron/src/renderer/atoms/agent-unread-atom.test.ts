import { beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta } from '@profer/shared'
import {
  agentSessionsAtom,
  memoryUnviewedCompletedSessionIdsAtom,
  unviewedCompletedSessionIdsAtom,
} from './agent-atoms'
import { manualReadConfirmEnabledAtom } from './agent-unread-settings'
import { deriveUnreadIdsFromSessions, resetAgentUnreadDeriveCache } from '@/lib/agent-unread-derive'

/**
 * 模式感知的未读 atom（`design.md` §2.2 / §10 单测第 3 组）。
 *
 * 关闭态＝现状的独立内存集合（读＝内存、写＝内存）；开启态＝由持久化字段派生、
 * 渲染层写入**静默丢弃**。后者是刻意设计而不是疏忽，必须被单测锁死，否则看起来像 bug。
 */

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
  resetAgentUnreadDeriveCache()
})

describe('关闭态：读＝内存集合、写＝内存集合（与既有实现一致）', () => {
  test('Given 默认关闭 When 写入未读集合 Then 读回同一集合（内存集合是显示权威）', () => {
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['a', 'b']))
    expect([...store.get(unviewedCompletedSessionIdsAtom)].sort()).toEqual(['a', 'b'])
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)].sort()).toEqual(['a', 'b'])
  })

  test('Given 默认关闭 When 用函数式更新 Then 生效（R1–R10 的写入点写法全部保留）', () => {
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['a']))
    store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev)
      next.delete('a')
      next.add('c')
      return next
    })
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['c'])
  })

  test('Given 关闭态且持久化字段为 true When 读未读集合 Then 不受持久化字段影响（保真：完成类未读不落盘）', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session('persisted', true)])
    expect(store.get(unviewedCompletedSessionIdsAtom).size).toBe(0)
  })
})

describe('开启态：读＝持久化字段派生、渲染层写入不生效', () => {
  test('Given 开关开启 When 读未读集合 Then 与 completedButUnconfirmed 一致', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('a', true), session('b', false), session('c')])

    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['a'])
  })

  test('Given 开关开启 When 渲染层写入未读集合 Then 静默丢弃（自动清除路径统一失效的机制）', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('a', true)])

    store.set(unviewedCompletedSessionIdsAtom, new Set<string>())
    store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev)
      next.add('ghost')
      return next
    })

    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['a'])
    expect(store.get(memoryUnviewedCompletedSessionIdsAtom).size).toBe(0)
  })

  test('Given 开关开启 When 持久化字段翻转 Then 未读集合随之变化（事实源唯一）', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('a', true)])
    expect(store.get(unviewedCompletedSessionIdsAtom).has('a')).toBe(true)

    store.set(agentSessionsAtom, [session('a', false)])
    expect(store.get(unviewedCompletedSessionIdsAtom).has('a')).toBe(false)
  })

  test('Given 开关开启 When 会话从列表移除 Then 自动不再计入（删除不需要额外清未读）', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('a', true), session('b', true)])
    expect(store.get(unviewedCompletedSessionIdsAtom).size).toBe(2)

    store.set(agentSessionsAtom, [session('b', true)])
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['b'])
  })
})

describe('模式切换不丢未读', () => {
  test('Given 关闭态有内存未读 When 切到开启态 Then 内存集合原样保留（由迁移补写持久化未读）', () => {
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['a']))
    store.set(manualReadConfirmEnabledAtom, true)

    expect(store.get(memoryUnviewedCompletedSessionIdsAtom).has('a')).toBe(true)
  })

  test('Given 开启态有持久化未读 When 切回关闭态 Then 内存集合仍需被回填（由初始化/迁移负责）', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('a', true)])
    store.set(manualReadConfirmEnabledAtom, false)

    // 切换本身不迁移：未读迁移是显式动作（planModeTransition / 启动回填），
    // 这里断言的是「切回关闭态不会顺手清掉内存集合」。
    expect(store.get(memoryUnviewedCompletedSessionIdsAtom).size).toBe(0)
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['a']))
    expect([...store.get(unviewedCompletedSessionIdsAtom)]).toEqual(['a'])
  })
})

describe('派生集合的引用稳定性（避免下游 useMemo 每帧失效）', () => {
  test('Given 同一份输入 When 重复派生 Then 返回同一个 Set 实例', () => {
    const first = deriveUnreadIdsFromSessions([session('a', true), session('b', false)])
    const second = deriveUnreadIdsFromSessions([session('a', true), session('b', false)])
    expect(second).toBe(first)
  })

  test('Given 未读成员不变但列表顺序变化 When 派生 Then 仍是同一实例', () => {
    const first = deriveUnreadIdsFromSessions([session('a', true), session('b', true)])
    const second = deriveUnreadIdsFromSessions([session('b', true), session('a', true)])
    expect(second).toBe(first)
  })

  test('Given 未读成员变化 When 派生 Then 返回新实例', () => {
    const first = deriveUnreadIdsFromSessions([session('a', true)])
    const second = deriveUnreadIdsFromSessions([session('a', true), session('b', true)])
    expect(second).not.toBe(first)
    expect([...second].sort()).toEqual(['a', 'b'])
  })
})
