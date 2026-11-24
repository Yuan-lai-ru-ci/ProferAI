import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta, AgentSessionUiProjection, AgentStreamEvent, AgentStreamPayload, SDKMessage } from '@profer/shared'
import { buildAgentSessionUiProjection } from '@profer/shared'
import {
  agentFileChangesCurrentRunAtom, agentPermissionModeMapAtom, agentPlanModeSessionsAtom,
  agentSessionsAtom, agentStreamingStatesAtom, liveMessagesMapAtom,
  stoppedByUserSessionsAtom, unviewedCompletedSessionIdsAtom,
  type AgentStreamState,
} from '../atoms/agent-atoms'
import { installGlobalAgentListeners } from './useGlobalAgentListeners'

const session: AgentSessionMeta = { id: 'permission-test', title: '权限回归', createdAt: 1, updatedAt: 1, permissionMode: 'plan', revision: 1 }
const cleanup: Array<() => void> = []
const originalWindow = globalThis.window

afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose())
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

function harness(initial?: AgentStreamState) {
  const callbacks = new Set<(event: AgentStreamEvent) => void>()
  const noopSubscription = () => () => {}
  let sessionUpdated: ((event: { session: AgentSessionMeta }) => void) | undefined
  const host = {
    listGoals: async () => [], listGoalProposals: async () => [], listAgentSessions: async () => [session],
    onGoalEvent: noopSubscription, onAgentSessionReleased: noopSubscription,
    onAgentStreamComplete: noopSubscription, onAgentStreamError: noopSubscription,
    onAgentTitleUpdated: noopSubscription,
    onAgentSessionUpdated: (callback: typeof sessionUpdated) => { sessionUpdated = callback; return () => { sessionUpdated = undefined } },
    onTodoAgentSessionReady: noopSubscription,
    onAgentSessionActivityInvalidated: noopSubscription,
    restoreActiveAgentStreams: async () => [],
    onAgentStreamEvent: (callback: (event: AgentStreamEvent) => void) => {
      callbacks.add(callback)
      return () => { callbacks.delete(callback) }
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    electronAPI: host, location: { search: '' }, addEventListener() {}, removeEventListener() {},
  } as unknown as Window })
  const store = createStore()
  store.set(agentSessionsAtom, [session])
  store.set(unviewedCompletedSessionIdsAtom, new Set([session.id]))
  store.set(stoppedByUserSessionsAtom, new Set([session.id]))
  if (initial) store.set(agentStreamingStatesAtom, new Map([[session.id, initial]]))
  cleanup.push(installGlobalAgentListeners(store))
  return { store, updateSession: (updated: AgentSessionMeta) => sessionUpdated?.({ session: updated }), emit: (payload: AgentStreamPayload) => {
    for (const callback of callbacks) callback({ sessionId: session.id, payload })
  } }
}

function projection(revision: number, permissionMode: AgentSessionMeta['permissionMode']): AgentSessionUiProjection {
  return buildAgentSessionUiProjection({ ...session, revision, permissionMode, agentRuntime: 'pi' })
}

describe('真实全局 listener 的权限配置路径', () => {
  for (const initial of [undefined, { running: false, content: '已停止', toolActivities: [], startedAt: 10 }, { running: true, content: '执行中', toolActivities: [], startedAt: 20 }] satisfies Array<AgentStreamState | undefined>) {
    test(`配置事件保留 ${initial?.running ?? '无 entry'} 的运行态且无 run 副作用`, () => {
      const { store, emit } = harness(initial)
      const before = store.get(agentStreamingStatesAtom)
      emit({ kind: 'profer_event', event: { type: 'permission_mode_changed', mode: 'bypassPermissions' } })
      emit({ kind: 'profer_event', event: { type: 'plan_mode_changed', sessionId: session.id, active: true, source: 'tool' } })
      expect(store.get(agentStreamingStatesAtom)).toBe(before)
      expect(store.get(unviewedCompletedSessionIdsAtom).has(session.id)).toBe(true)
      expect(store.get(stoppedByUserSessionsAtom).has(session.id)).toBe(true)
      expect(store.get(agentFileChangesCurrentRunAtom).has(session.id)).toBe(false)
      expect(store.get(liveMessagesMapAtom).has(session.id)).toBe(false)
      expect(store.get(agentPermissionModeMapAtom).get(session.id)).toBe('bypassPermissions')
      expect(store.get(agentPlanModeSessionsAtom).has(session.id)).toBe(true)
    })
  }

  test('旧 projection 不能覆盖新权限缓存或计划态', () => {
    const { store, emit } = harness()
    emit({ kind: 'session_projection', operation: 'upsert', session: projection(3, 'bypassPermissions') })
    emit({ kind: 'session_projection', operation: 'upsert', session: projection(2, 'plan') })
    expect(store.get(agentSessionsAtom)[0]?.permissionMode).toBe('bypassPermissions')
    expect(store.get(agentPermissionModeMapAtom).get(session.id)).toBe('bypassPermissions')
    expect(store.get(agentPlanModeSessionsAtom).has(session.id)).toBe(false)
  })

  test('legacy 会话回执在换预设时同步权限缓存，旧回执不能恢复旧计划态', () => {
    const { store, updateSession } = harness()
    updateSession({ ...session, revision: 3, permissionMode: 'bypassPermissions', permissionModeSource: 'preset' })
    updateSession({ ...session, revision: 2, permissionMode: 'plan' })
    expect(store.get(agentSessionsAtom)[0]?.permissionMode).toBe('bypassPermissions')
    expect(store.get(agentPermissionModeMapAtom).get(session.id)).toBe('bypassPermissions')
    expect(store.get(agentPlanModeSessionsAtom).has(session.id)).toBe(false)
  })

  test('SDK EnterPlanMode / ExitPlanMode 仍更新计划阶段而不改用户权限选择', () => {
    const { store, emit } = harness({ running: true, content: '', toolActivities: [] })
    emit({ kind: 'profer_event', event: { type: 'permission_mode_changed', mode: 'bypassPermissions' } })
    for (const [name, active] of [['EnterPlanMode', true], ['ExitPlanMode', true]] as const) {
      emit({ kind: 'sdk_message', message: { type: 'assistant', uuid: name, message: { content: [{ type: 'tool_use', id: name, name, input: {} }] } } as unknown as SDKMessage })
      expect(store.get(agentPlanModeSessionsAtom).has(session.id)).toBe(active)
      expect(store.get(agentPermissionModeMapAtom).get(session.id)).toBe('bypassPermissions')
    }
    emit({ kind: 'profer_event', event: { type: 'plan_mode_changed', sessionId: session.id, active: false, source: 'tool' } })
    expect(store.get(agentPlanModeSessionsAtom).has(session.id)).toBe(false)
  })

  test('runtime_started 仍为真正的新 run 创建运行态', () => {
    const { store, emit } = harness()
    emit({ kind: 'profer_event', event: { type: 'runtime_started', sessionId: session.id, runId: 'real-run', startedAt: 100 } })
    expect(store.get(agentStreamingStatesAtom).get(session.id)).toMatchObject({ running: true, runId: 'real-run', startedAt: 100 })
  })

  test('单独 plan 配置不会为无 entry 会话建立 run', () => {
    const { store, emit } = harness()
    emit({ kind: 'profer_event', event: { type: 'plan_mode_changed', sessionId: session.id, active: true, source: 'tool' } })
    expect(store.get(agentStreamingStatesAtom).has(session.id)).toBe(false)
    expect(store.get(stoppedByUserSessionsAtom).has(session.id)).toBe(true)
    expect(store.get(unviewedCompletedSessionIdsAtom).has(session.id)).toBe(true)
  })

  test('真实 run_resumed 仍恢复运行态', () => {
    const { store, emit } = harness({ running: false, content: '', toolActivities: [], backgroundWaiting: true })
    emit({ kind: 'profer_event', event: { type: 'run_resumed', sessionId: session.id } })
    expect(store.get(agentStreamingStatesAtom).get(session.id)?.running).toBe(true)
  })
})
