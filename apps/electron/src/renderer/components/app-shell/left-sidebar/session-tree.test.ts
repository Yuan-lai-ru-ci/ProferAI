/**
 * session-tree.test.ts — 委派会话树状态聚合测试
 *
 * 核心关注：父会话的 completed（绿色）标记只反映父会话自身的未查看完成，
 * 不被子代理"已完成未查看"状态传染。
 */

import { describe, expect, test } from 'bun:test'
import { collectDelegatedDeletionSessionIds, getDelegatedChildStatus, getSessionTreeStatus, type AgentSessionTreeItem } from './session-tree'
import type { AgentSessionMeta } from '@profer/shared'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'

const NOW = 1_752_000_000_000

function makeSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: `session-${Math.random()}`,
    title: '会话',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeItem(parentId: string, childIds: string[]): AgentSessionTreeItem {
  return {
    session: makeSession({ id: parentId, title: '父会话' }),
    childSessions: childIds.map((id) => makeSession({
      id,
      title: '子会话',
      parentSessionId: parentId,
      sourceDelegationId: 'deleg-1',
    })),
  }
}

function makeMap(entries: Record<string, SessionIndicatorStatus>): Map<string, SessionIndicatorStatus> {
  return new Map(Object.entries(entries))
}

describe('collectDelegatedDeletionSessionIds', () => {
  test('Given 嵌套委派子会话和普通会话 When 收集删除范围 Then 仅包含根与所有委派后代', () => {
    const sessions = [
      makeSession({ id: 'parent' }),
      makeSession({ id: 'child', parentSessionId: 'parent', sourceDelegationId: 'd-child' }),
      makeSession({ id: 'grandchild', parentSessionId: 'child', sourceDelegationId: 'd-grandchild' }),
      makeSession({ id: 'ordinary', parentSessionId: 'parent' }),
      makeSession({ id: 'unrelated', parentSessionId: 'other', sourceDelegationId: 'd-other' }),
    ]

    expect(collectDelegatedDeletionSessionIds(sessions, 'parent')).toEqual(new Set(['parent', 'child', 'grandchild']))
  })
})

describe('getSessionTreeStatus — 父会话状态聚合', () => {
  test('Given 父会话 idle 且子代理完成后未查看 When 聚合状态 Then 父会话为 idle（不显示绿色完成标记）', () => {
    const item = makeItem('parent-1', ['child-1'])
    const map = makeMap({ 'child-1': 'completed' })

    expect(getSessionTreeStatus(item, map)).toBe('idle')
  })

  test('Given 父会话 idle 且子代理正在运行 When 聚合状态 Then 父会话为 running（子代理活动需体现）', () => {
    const item = makeItem('parent-2', ['child-2'])
    const map = makeMap({ 'child-2': 'running' })

    expect(getSessionTreeStatus(item, map)).toBe('running')
  })

  test('Given 父会话 idle 且子代理被阻塞 When 聚合状态 Then 父会话为 blocked', () => {
    const item = makeItem('parent-3', ['child-3'])
    const map = makeMap({ 'child-3': 'blocked' })

    expect(getSessionTreeStatus(item, map)).toBe('blocked')
  })

  test('Given 父会话自身已完成未查看 When 聚合状态 Then 父会话保持 completed（不因无子代理活动而丢失）', () => {
    const item = makeItem('parent-4', ['child-4'])
    const map = makeMap({ 'parent-4': 'completed' })

    expect(getSessionTreeStatus(item, map)).toBe('completed')
  })

  test('Given 父会话 completed 且子代理 running When 聚合状态 Then 按优先级返回 running', () => {
    const item = makeItem('parent-5', ['child-5'])
    const map = makeMap({ 'parent-5': 'completed', 'child-5': 'running' })

    expect(getSessionTreeStatus(item, map)).toBe('running')
  })

  test('Given 父会话 idle 且无子会话 When 聚合状态 Then 父会话为 idle', () => {
    const item = makeItem('parent-6', [])

    expect(getSessionTreeStatus(item, new Map())).toBe('idle')
  })

  test('Given 子代理运行中但无实时指示器（delegationStatus 持久化为 running）When 聚合状态 Then 子会话为 running 并向上聚合', () => {
    const child = makeSession({
      id: 'child-7',
      title: '子会话',
      parentSessionId: 'parent-7',
      sourceDelegationId: 'deleg-7',
      delegationStatus: 'running',
    })
    const item: AgentSessionTreeItem = {
      session: makeSession({ id: 'parent-7', title: '父会话' }),
      childSessions: [child],
    }

    expect(getDelegatedChildStatus(child, new Map())).toBe('running')
    expect(getSessionTreeStatus(item, new Map())).toBe('running')
  })
})
