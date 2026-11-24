import { expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@profer/shared'
import { attachLocalCoreClient, detachLocalCoreClient, isLocalCoreSessionActive, registerLocalCoreSession } from './core-local-bridge'
import type { CoreAgentEvent, CoreClient } from './core-client'

test('本机 Core 主动推送和桌面接管均通知活动边界；接管后不再发布第二份完成', () => {
  const listeners = new Set<(event: CoreAgentEvent) => void>()
  const listen = (fn: (event: CoreAgentEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  const client = { addEventListener: listen, addSnapshotListener: () => () => {}, addWorkspaceEventListener: () => () => {}, addAutomationEventListener: () => () => {}, identity: async () => ({ coreId: 'local' }), setHostRequestHandler: () => {} } as unknown as CoreClient
  const frames: Array<[string, string, unknown]> = []
  const emit = (type: string) => listeners.forEach(fn => fn({ kind: 'agent_event', sessionId: 's', payload: { kind: 'profer_event', event: { type } } }))
  try {
    attachLocalCoreClient(client, (...args) => frames.push(args))
    emit('runtime_started'); expect(isLocalCoreSessionActive('s')).toBe(true)
    emit('run_completed'); expect(isLocalCoreSessionActive('s')).toBe(false)
    expect(frames.map(f => f[0])).toEqual([C.SESSION_ACTIVITY_INVALIDATED,C.STREAM_EVENT,C.SESSION_ACTIVITY_INVALIDATED,C.STREAM_EVENT,C.STREAM_COMPLETE])
    frames.length = 0
    let owned = 0
    const release = registerLocalCoreSession('s', () => { owned++ })
    emit('runtime_started'); emit('run_completed'); release()
    expect(owned).toBe(2)
    expect(frames).toEqual(Array(2).fill([C.SESSION_ACTIVITY_INVALIDATED,'s',{ sessionId: 's' }]))
    detachLocalCoreClient(false)
    emit('run_completed'); expect(frames).toHaveLength(2)
  } finally { detachLocalCoreClient(false) }
})
