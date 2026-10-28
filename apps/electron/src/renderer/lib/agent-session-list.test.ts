import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@profer/shared'
import {
  syncDraftSessionId,
  sortAgentSessionsByUpdatedAtDesc,
  replaceAgentSessionInFreshnessOrder,
  upsertAgentSession,
  upsertAgentSessionProjection,
  mergeFetchedAgentSessions,
} from './agent-session-list'

function makeSession(
  id: string,
  updatedAt: number,
  extra: Partial<AgentSessionMeta> = {},
): AgentSessionMeta {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  }
}

describe('sortAgentSessionsByUpdatedAtDesc', () => {
  test('Given 乱序会话 When 排序 Then 按 updatedAt 降序', () => {
    const result = sortAgentSessionsByUpdatedAtDesc([
      makeSession('a', 1),
      makeSession('b', 3),
      makeSession('c', 2),
    ])
    expect(result.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('replaceAgentSessionInFreshnessOrder', () => {
  test('Given 列表中已有同 id When 用新元数据替换 Then 替换并重排', () => {
    const result = replaceAgentSessionInFreshnessOrder(
      [makeSession('a', 1), makeSession('b', 2)],
      makeSession('a', 5, { title: '新标题' }),
    )
    expect(result.map((s) => s.id)).toEqual(['a', 'b'])
    expect(result.find((s) => s.id === 'a')?.title).toBe('新标题')
  })
})

describe('upsertAgentSession', () => {
  test('Given 列表无该会话 When upsert Then 追加并重排', () => {
    const result = upsertAgentSession(
      [makeSession('a', 1)],
      makeSession('b', 3),
    )
    expect(result.map((s) => s.id)).toEqual(['b', 'a'])
  })

  test('Given 列表已有该会话 When upsert Then 浅合并字段，保留未覆盖字段', () => {
    const result = upsertAgentSession(
      [makeSession('a', 1, { channelId: 'ch-1', workspaceId: 'ws-1' })],
      makeSession('a', 9, { title: '改名' }),
    )
    const a = result.find((s) => s.id === 'a')!
    expect(a.title).toBe('改名')
    expect(a.updatedAt).toBe(9)
    // 未在 incoming 中提供的字段从既有条目保留
    expect(a.channelId).toBe('ch-1')
    expect(a.workspaceId).toBe('ws-1')
  })

  test('核心回归：upsert 子会话时绝不删除其它会话（含刚结束 turn 的父会话）', () => {
    const parent = makeSession('parent', 10)
    const childA = makeSession('child-a', 11, {
      parentSessionId: 'parent',
      sourceDelegationId: 'del-a',
    })
    // 模拟：列表里已有父会话 + 子会话 a，现在子会话 b 启动
    const childB = makeSession('child-b', 12, {
      parentSessionId: 'parent',
      sourceDelegationId: 'del-b',
    })
    const result = upsertAgentSession([parent, childA], childB)
    // 父会话与子会话 a 都必须仍然在列表中
    expect(result.map((s) => s.id).sort()).toEqual(['child-a', 'child-b', 'parent'])
  })

  test('回归：完整委派元数据到达时保留工作区与父子关系', () => {
    const placeholder = makeSession('child', 10, { parentSessionId: 'parent' })
    const persistedChild = makeSession('child', 20, {
      workspaceId: 'project-a',
      parentSessionId: 'parent',
      sourceDelegationId: 'delegation-a',
      delegationStatus: 'completed',
    })

    const result = upsertAgentSession([placeholder], persistedChild)
    expect(result[0]).toMatchObject({
      workspaceId: 'project-a',
      parentSessionId: 'parent',
      sourceDelegationId: 'delegation-a',
      delegationStatus: 'completed',
    })
  })
})

describe('upsertAgentSessionProjection', () => {
  const projection = (revision: number, extra: Partial<import('@profer/shared').AgentSessionUiProjection> = {}): import('@profer/shared').AgentSessionUiProjection => ({
    schemaVersion: 1,
    id: 'a',
    revision,
    title: `标题-${revision}`,
    createdAt: 1,
    updatedAt: revision,
    autoQueueSendEnabled: true,
    channelId: 'channel',
    modelId: 'model',
    agentRuntime: 'claude',
    permissionMode: 'auto',
    presetId: null,
    presetReference: null,
    openAIThinkingLevel: null,
    codexFastMode: false,
    agentEffort: null,
    attachedDirectories: [],
    attachedFiles: [],
    workspaceId: null,
    pinned: false,
    archived: false,
    draft: false,
    parentSessionId: null,
    rootSessionId: null,
    sourceDelegationId: null,
    explorationParentSessionId: null,
    explorationSourceMessageId: null,
    explorationSourceLabel: null,
    delegationRole: null,
    delegationStatus: null,
    delegationDepth: null,
    sourceAutomationId: null,
    automationGraduated: false,
    completedButUnconfirmed: false,
    stoppedByUser: false,
    lastInterruptReason: null,
    lastInterruptLabel: null,
    lastInterruptAt: null,
    ...extra,
  })

  test('实时投影保留未知探索分支的三字段', () => {
    const result = upsertAgentSessionProjection([], projection(2, {
      id: 'exploration-branch',
      explorationParentSessionId: 'mainline',
      explorationSourceMessageId: 'assistant-1',
      explorationSourceLabel: '这条 Agent 回复',
    }))
    expect(result[0]).toMatchObject({
      id: 'exploration-branch',
      explorationParentSessionId: 'mainline',
      explorationSourceMessageId: 'assistant-1',
      explorationSourceLabel: '这条 Agent 回复',
    })
  })

  test('低 revision 不覆盖较新的权限模式', () => {
    const current = makeSession('a', 10, { revision: 3, permissionMode: 'plan' })
    const result = upsertAgentSessionProjection([current], projection(2, { permissionMode: 'auto' }))
    expect(result[0]).toMatchObject({ revision: 3, permissionMode: 'plan' })
  })

  test('首次发送锁定 projection 可刷新恢复，迟到的未锁 projection 不回退', () => {
    const empty = upsertAgentSessionProjection([], projection(1, { agentRuntime: 'pi', agentRuntimeLocked: false }))
    const locked = upsertAgentSessionProjection(empty, projection(2, { agentRuntime: 'pi', agentRuntimeLocked: true }))
    const delayed = upsertAgentSessionProjection(locked, projection(1, { agentRuntime: 'claude', agentRuntimeLocked: false }))
    expect(delayed[0]).toMatchObject({ revision: 2, agentRuntime: 'pi', agentRuntimeLocked: true })
    expect(upsertAgentSessionProjection([], projection(2, { agentRuntime: 'pi', agentRuntimeLocked: true }))[0]).toMatchObject({ agentRuntime: 'pi', agentRuntimeLocked: true })
    expect(upsertAgentSessionProjection([], projection(1))[0]?.agentRuntimeLocked).toBe(true)
  })

  test('普通会话投影不伪造探索血缘', () => {
    const result = upsertAgentSessionProjection([], projection(1))
    expect(result[0]?.explorationParentSessionId).toBeUndefined()
    expect(result[0]?.explorationSourceMessageId).toBeUndefined()
  })
})

describe('mergeFetchedAgentSessions', () => {
  test('Given 后端快照含全部会话 When 合并 Then 以快照为准并重排', () => {
    const prev = [makeSession('a', 1)]
    const fetched = [makeSession('a', 5), makeSession('b', 6)]
    const result = mergeFetchedAgentSessions(prev, fetched)
    expect(result.map((s) => s.id)).toEqual(['b', 'a'])
    expect(result.find((s) => s.id === 'a')?.updatedAt).toBe(5)
  })

  test('核心回归：陈旧快照缺失刚结束 turn 的父会话 When 合并 Then 父会话被保留不被冲掉', () => {
    // 父会话刚结束 turn，updatedAt 较新；但某个并发回调的 fetch 早于它落盘，快照里没有它
    const parent = makeSession('parent', 100)
    const childA = makeSession('child-a', 90, {
      parentSessionId: 'parent',
      sourceDelegationId: 'del-a',
    })
    const prev = [parent, childA]
    // 陈旧快照：只有 child-a，没有 parent（且没有比 parent 更新的条目）
    const staleFetched = [makeSession('child-a', 90)]
    const result = mergeFetchedAgentSessions(prev, staleFetched)
    // parent.updatedAt(100) >= 快照水位(90)，应被判定为「快照尚未看到的新条目」而保留
    expect(result.some((s) => s.id === 'parent')).toBe(true)
  })

  test('删除语义：后端确实删除的旧会话（updatedAt 早于快照水位）不被保留', () => {
    // old 会话已被后端删除，且它的 updatedAt 早于快照里的最新条目
    const old = makeSession('old', 1)
    const prev = [old, makeSession('keep', 5)]
    // 权威快照里没有 old，且快照水位(8) > old.updatedAt(1) → old 视为已删除
    const fetched = [makeSession('keep', 8)]
    const result = mergeFetchedAgentSessions(prev, fetched)
    expect(result.some((s) => s.id === 'old')).toBe(false)
    expect(result.some((s) => s.id === 'keep')).toBe(true)
  })

  test('低 revision 全量快照不能覆盖刚绑定的会话', () => {
    const locked = makeSession('a', 10, { revision: 3, agentRuntime: 'pi', agentRuntimeLocked: true })
    const stale = makeSession('a', 9, { revision: 2, agentRuntime: 'claude', agentRuntimeLocked: false })
    expect(mergeFetchedAgentSessions([locked], [stale])[0]).toEqual(locked)
    expect(upsertAgentSession([locked], stale)[0]).toEqual(locked)
    expect(replaceAgentSessionInFreshnessOrder([locked], stale)[0]).toEqual(locked)
  })

  test('幂等：prev 与 fetched 完全一致 When 合并 Then 内容不变', () => {
    const sessions = [makeSession('a', 5), makeSession('b', 3)]
    const result = mergeFetchedAgentSessions(sessions, sessions)
    expect(result.map((s) => s.id)).toEqual(['a', 'b'])
    expect(result).toHaveLength(2)
  })
})

describe('syncDraftSessionId — 草稿标记与持久化状态保持一致', () => {
  test('Given 会话仍是持久化草稿 When 同步 Then 标记进内存草稿集', () => {
    const result = syncDraftSessionId(new Set(), { id: 'draft-1', draft: true })

    expect(result.has('draft-1')).toBe(true)
  })

  test('核心回归：会话已晋升（draft=false）但内存标记残留 When 同步 Then 清除标记，会话得以进入项目列表', () => {
    const result = syncDraftSessionId(new Set(['promoted']), { id: 'promoted', draft: false })

    expect(result.has('promoted')).toBe(false)
  })

  test('Given 已晋升会话且内存本来就干净 When 同步 Then 原样返回同一引用（不触发无谓重渲染）', () => {
    const ids = new Set(['other'])

    expect(syncDraftSessionId(ids, { id: 'promoted', draft: false })).toBe(ids)
  })

  test('Given 草稿且已标记 When 同步 Then 原样返回同一引用', () => {
    const ids = new Set(['draft-1'])

    expect(syncDraftSessionId(ids, { id: 'draft-1', draft: true })).toBe(ids)
  })

  test('Given draft 字段缺失 When 同步 Then 按正式会话处理并清除标记', () => {
    const result = syncDraftSessionId(new Set(['legacy']), { id: 'legacy' })

    expect(result.has('legacy')).toBe(false)
  })

  test('Given 同步不修改传入集合 When 清除 Then 入参集合保持不变', () => {
    const ids = new Set(['a'])

    syncDraftSessionId(ids, { id: 'a', draft: false })

    expect(ids.has('a')).toBe(true)
  })
})
