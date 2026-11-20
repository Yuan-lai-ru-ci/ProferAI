import { describe, expect, test } from 'bun:test'
import { projectRemoteRunEvent } from './core-run-projection'
import type { CoreAgentEvent } from './core-client'

function event(payload: Record<string, unknown>): CoreAgentEvent {
  return { kind: 'agent_event', sessionId: 'remote-1', payload }
}

describe('remote Core run event projection', () => {
  test('会话安全投影给父子引用加Core命名空间，不改写源对象', () => {
    const session = { id: 'raw', parentSessionId: 'parent', rootSessionId: 'root', explorationParentSessionId: 'source', sourceSessionId: null }
    const projected = projectRemoteRunEvent(event({ kind: 'session_projection', operation: 'upsert', session }), 'core:owner:raw')
    expect(projected?.eventPayload).toEqual({ kind: 'session_projection', operation: 'upsert', session: { ...session, id: 'core:owner:raw', parentSessionId: 'core:owner:parent', rootSessionId: 'core:owner:root', explorationParentSessionId: 'core:owner:source' } })
    expect(session.id).toBe('raw')
  })
  test.each([
    { name: 'completed', stoppedByUser: false, resultSubtype: 'success' },
    { name: 'failed', stoppedByUser: false, resultSubtype: 'error_during_execution', resultErrors: ['provider failed'] },
    { name: 'stopped', stoppedByUser: true },
  ])('maps $name runtime completion to the renderer completion contract', input => {
    const projected = projectRemoteRunEvent(event({ kind: 'profer_event', event: { type: 'run_completed', ...input } }), 'core:remote-1')
    expect(projected?.eventPayload).toMatchObject({ kind: 'profer_event', event: { type: 'run_completed' } })
    expect(projected?.completion).toEqual({
      sessionId: 'core:remote-1', messages: [], stoppedByUser: input.stoppedByUser,
      ...(input.resultSubtype ? { resultSubtype: input.resultSubtype } : {}),
      ...('resultErrors' in input ? { resultErrors: ['provider failed'] } : {}),
    })
  })

  test('preserves run startedAt so the renderer accepts the terminal frame', () => {
    const projected = projectRemoteRunEvent(
      event({ kind: 'profer_event', event: { type: 'run_completed', startedAt: 1760000000000, stoppedByUser: false, resultSubtype: 'success' } }),
      'core:remote-1',
    )
    expect(projected?.completion).toEqual({
      sessionId: 'core:remote-1', messages: [], stoppedByUser: false, resultSubtype: 'success', startedAt: 1760000000000,
    })
  })

  test.each(['permission_request', 'ask_user_request', 'exit_plan_mode_request'])('%s 投影保留原Run但命名空间化session', type => {
    const source = { type, request: { requestId: 'request-1', sessionId: 'raw', runId: 'run-1' } }
    expect(projectRemoteRunEvent(event({ kind: 'profer_event', event: source }), 'core:owner:raw')?.eventPayload).toEqual({
      kind: 'profer_event', event: { ...source, request: { ...source.request, sessionId: 'core:owner:raw' } },
    })
    expect(source.request.sessionId).toBe('raw')
  })

  test('Given SDK用量投影 When 转发 Then 保留快照与Run身份且不改写源数据', () => {
    const payload = { kind: 'sdk_message', message: { type: 'assistant' }, contextUsage: { inputTokens: 42, usageUpdatedAt: 123 }, runId: 'run-new', startedAt: 456 }
    expect(projectRemoteRunEvent(event(payload), 'core:owner:raw')?.eventPayload).toEqual(payload)
    expect(payload.contextUsage).toEqual({ inputTokens: 42, usageUpdatedAt: 123 })
    expect(projectRemoteRunEvent(event({ ...payload, contextUsage: null }), 'core:owner:raw')?.eventPayload?.contextUsage).toBeNull()
  })

  test('projects SDK messages and execution errors independently', () => {
    const sdkMessage = { type: 'assistant', content: [] }
    expect(projectRemoteRunEvent(event({ kind: 'sdk_message', message: sdkMessage }), 'local')).toEqual({ eventPayload: { kind: 'sdk_message', message: sdkMessage } })
    expect(projectRemoteRunEvent(event({ kind: 'run_error', error: 'failed' }), 'local')).toEqual({ error: 'failed' })
    expect(projectRemoteRunEvent(event({ kind: 'run_error' }), 'local')).toEqual({ error: '远程 Core 执行失败' })
  })
})
