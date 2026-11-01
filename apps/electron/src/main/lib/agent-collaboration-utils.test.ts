import { describe, expect, test } from 'bun:test'
import { PROFER_DEFAULT_PERMISSION_MODE } from '@profer/shared'
import {
  buildDelegationDispatchFacts,
  resolveDelegationArrangement,
  resolveDelegationPermissionMode,
} from './agent-collaboration-utils'

const modes = ['plan', 'auto', 'bypassPermissions'] as const

describe('委派权限与归属', () => {
  for (const parent of modes) {
    for (const target of modes) {
      test(`委派权限取父与目标预设的较严格值 (${parent} / ${target})`, () => {
        const expected = modes[Math.min(modes.indexOf(parent), modes.indexOf(target))]!
        expect(resolveDelegationPermissionMode(parent, target, 'claude')).toBe(expected)
        expect(resolveDelegationPermissionMode(parent, target, 'pi')).toBe(expected)
      })
    }
  }
  test('无授权上下文时采用既有全局默认', () => {
    expect(resolveDelegationPermissionMode()).toBe(PROFER_DEFAULT_PERMISSION_MODE)
  })
  test('省略位置保留旧 child 行为，但显式位置与关系互相校验', () => {
    expect(resolveDelegationArrangement({})).toEqual({ placement: 'child', relation: 'subtask' })
    expect(resolveDelegationArrangement({ placement: 'current' })).toEqual({ placement: 'current', relation: 'subtask' })
    expect(resolveDelegationArrangement({ relation: 'independent' })).toEqual({ placement: 'independent', relation: 'independent' })
    expect(() => resolveDelegationArrangement({ placement: 'child', relation: 'independent' })).toThrow()
  })
  test('来源只由宿主事实生成，任务稳定而每次继续有独立触发', () => {
    const first = buildDelegationDispatchFacts({ sessionId: 'source', sourceRunId: 'run-source', delegationId: 'task-1', triggerId: 'initial-1' })
    const next = buildDelegationDispatchFacts({ sessionId: 'source', sourceRunId: 'run-next', delegationId: 'task-1', triggerId: 'continue-1' })
    expect(first).toMatchObject({ taskId: 'task-1', triggerId: 'initial-1', messageAuthor: { type: 'agent', id: 'source' }, taskOrigin: { actor: { type: 'agent', id: 'source' }, source: { type: 'run', id: 'run-source' } }, taskAuthorization: { kind: 'inherited', sourceRef: { type: 'run', id: 'run-source' } } })
    expect(next.taskId).toBe(first.taskId)
    expect(next.triggerId).not.toBe(first.triggerId)
    expect(buildDelegationDispatchFacts({ sessionId: 'source', delegationId: 'task-1', triggerId: 'i' }).taskOrigin.source).toEqual({ type: 'session', id: 'source' })
  })
})
