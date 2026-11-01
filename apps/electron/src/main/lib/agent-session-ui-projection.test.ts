import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@profer/shared'
import { buildAgentSessionUiProjection } from './agent-session-ui-projection'

function session(overrides: Partial<AgentSessionMeta> & { id: string }): AgentSessionMeta {
  return {
    title: overrides.id,
    createdAt: 1,
    updatedAt: 2,
    workspaceId: 'ws-1',
    ...overrides,
  }
}

describe('buildAgentSessionUiProjection — 置顶投影', () => {
  test('根会话保留置顶状态', () => {
    expect(buildAgentSessionUiProjection(session({ id: 'root', pinned: true })).pinned).toBe(true)
  })

  test('委派子会话的置顶状态不对外投影', () => {
    const projection = buildAgentSessionUiProjection(session({
      id: 'child',
      pinned: true,
      parentSessionId: 'root',
      sourceDelegationId: 'd-1',
    }))
    expect(projection.pinned).toBe(false)
  })

  test('探索分支的置顶状态不对外投影', () => {
    const projection = buildAgentSessionUiProjection(session({
      id: 'branch',
      pinned: true,
      explorationParentSessionId: 'root',
      explorationSourceMessageId: 'm-1',
    }))
    expect(projection.pinned).toBe(false)
  })
})
