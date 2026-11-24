import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta } from '@profer/shared'
import { agentPermissionModeMapAtom, agentPlanModeSessionsAtom, agentSessionsAtom } from '../atoms/agent-atoms'
import { applyAuthoritativeSessionPermission, resolveSessionPermissionMode } from './agent-session-permission'

const session: AgentSessionMeta = { id: 's', title: 's', createdAt: 1, updatedAt: 1, revision: 2, permissionMode: 'bypassPermissions' }

describe('会话权威权限同步', () => {
  test('权威模式优先旧 map，缺失权威值时才使用缓存或预设默认', () => {
    expect(resolveSessionPermissionMode('plan', 'bypassPermissions', 'plan')).toBe('bypassPermissions')
    expect(resolveSessionPermissionMode('plan', undefined, 'auto')).toBe('auto')
    expect(resolveSessionPermissionMode('plan')).toBe('plan')
  })
  test('换预设回执同时更新缓存和计划态，旧回执不产生部分写入', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session])
    store.set(agentPermissionModeMapAtom, new Map([['s', 'bypassPermissions']]))
    expect(applyAuthoritativeSessionPermission(store, { ...session, revision: 3, permissionMode: 'plan' })).toBe(true)
    expect(store.get(agentPermissionModeMapAtom).get('s')).toBe('plan')
    expect(store.get(agentPlanModeSessionsAtom).has('s')).toBe(true)
    expect(applyAuthoritativeSessionPermission(store, session)).toBe(false)
    expect(store.get(agentPermissionModeMapAtom).get('s')).toBe('plan')
    expect(store.get(agentSessionsAtom)[0]?.permissionMode).toBe('plan')
    expect(store.get(agentPlanModeSessionsAtom).has('s')).toBe(true)
  })
  test('回执未带模式时清掉旧缓存，不让旧 map 隐性复活', () => {
    const store = createStore()
    applyAuthoritativeSessionPermission(store, { ...session, permissionMode: 'plan' })
    applyAuthoritativeSessionPermission(store, { ...session, revision: 3, permissionMode: undefined })
    expect(store.get(agentPermissionModeMapAtom).has('s')).toBe(false)
    expect(store.get(agentPlanModeSessionsAtom).has('s')).toBe(false)
  })
})
