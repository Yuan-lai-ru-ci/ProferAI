import { expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS as C } from '@profer/shared'
import { invalidatesAgentActivity, invalidateAgentActivity } from './agent-window-delivery'

test('只在运行边界发出状态失效；不发送 token、正文、权限、错误详情或完成通知', () => {
  const frames: unknown[] = []
  const peer = { id: 1, isDestroyed: () => false, send: (...args: unknown[]) => frames.push(args) }
  const closed = { ...peer, isDestroyed: () => true }
  for (const type of ['external_run_started', 'runtime_started', 'runtime_idle', 'run_completed', 'run_idle']) {
    expect(invalidatesAgentActivity({ kind: 'profer_event', event: { type } })).toBe(true)
  }
  for (const payload of [{ kind: 'sdk_message', message: 'token' }, { kind: 'profer_event', event: { type: 'permission_request' } }, undefined, { kind: 'catalog_invalidation' }]) expect(invalidatesAgentActivity(payload)).toBe(false)
  invalidateAgentActivity([peer, closed], 's')
  expect(frames).toEqual([[C.SESSION_ACTIVITY_INVALIDATED, { sessionId: 's' }]])
})
