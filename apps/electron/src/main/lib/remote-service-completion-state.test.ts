import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta } from '@profer/shared'
import * as actualSessionManager from './agent-session-manager'
import * as actualPublisher from './agent-session-ui-projection-publisher'
import type { AgentUnreadPolicyMode } from './agent-unread-policy'

/**
 * 移动端（Pocket）未读命令的双模式门控（`requirements.md` §3.2-2/3/5、§5.5；`design.md` §10 单测第 2/3 组）。
 *
 * 两条口径：
 * - `mark_session_read`：关闭态无条件清（现状回归）；开启态必须带显式 `explicit: true` 才清。
 *   Pocket 关闭标签页时会自动调本命令，那是导航副作用而不是用户意图，否则手机上一划就把桌面
 *   未读吃掉且无处恢复。
 * - `toggle_session_archive`：与桌面 `TOGGLE_ARCHIVE` 共用同一纯策略函数——关闭态不碰未读，
 *   开启态归档视作已读（移动端归档清桌面未读属开启态策略，保留）。
 *
 * 验证方式：只替换三处副作用（会话读取、唯一写入口、当前模式），直调 `handleRemoteCommand`
 * 并断言**真实是否发生写入**，不启动真实会话数据、不读真实 settings.json。
 */

const meta = {
  id: 'session-under-test',
  title: '未读会话',
  channelId: 'channel-under-test',
  modelId: 'model-under-test',
  workspaceId: 'workspace-under-test',
  createdAt: 1,
  updatedAt: 2,
  revision: 7,
  archived: false,
  pinned: false,
  completedButUnconfirmed: true,
} as AgentSessionMeta

/** 由用例改写的当前模式；mock 的 getAgentUnreadPolicyMode 每次调用都读它。 */
const modeHolder: { current: AgentUnreadPolicyMode } = { current: 'auto' }

const unreadWrites: Array<{ sessionId: string; unread: boolean }> = []
const uiMetaWrites: Array<{ sessionId: string; updates: Partial<AgentSessionMeta> }> = []

mock.module('./agent-session-manager', () => ({
  ...actualSessionManager,
  getAgentSessionMeta: (id: string) => (id === meta.id ? { ...meta } : undefined),
  listAgentSessions: (_includeArchived?: boolean) => [{ ...meta }],
}))

mock.module('./agent-session-ui-projection-publisher', () => ({
  ...actualPublisher,
  setAgentSessionUnread: (sessionId: string, unread: boolean) => {
    unreadWrites.push({ sessionId, unread })
    return { ...meta, completedButUnconfirmed: unread }
  },
  updateAgentSessionUiMeta: (sessionId: string, updates: Partial<AgentSessionMeta>) => {
    uiMetaWrites.push({ sessionId, updates })
    return { ...meta, ...updates }
  },
}))

mock.module('./agent-unread-mode', () => ({
  getAgentUnreadPolicyMode: () => modeHolder.current,
}))

let handleRemoteCommand: typeof import('./remote-service')['handleRemoteCommand']
let moduleReady: Promise<void>

beforeEach(async () => {
  unreadWrites.length = 0
  uiMetaWrites.length = 0
  modeHolder.current = 'auto'
  moduleReady ??= import('./remote-service').then((mod) => {
    handleRemoteCommand = mod.handleRemoteCommand
  })
  await moduleReady
})

describe('mark_session_read：关闭态保持原行为', () => {
  test('Given 关闭态 When 缺少 explicit（Pocket 关标签页的自动调用） Then 仍无条件清未读', async () => {
    const result = await handleRemoteCommand(JSON.stringify({ type: 'mark_session_read', sessionId: meta.id }), 7)
    expect(result.ok).toBe(true)
    expect(unreadWrites).toEqual([{ sessionId: meta.id, unread: false }])
  })
})

describe('mark_session_read：开启态只响应显式「标记已读」', () => {
  test('Given 开启态 When 缺少 explicit Then no-op（不写状态，仍返回当前会话）', async () => {
    modeHolder.current = 'manual'
    const result = await handleRemoteCommand(JSON.stringify({ type: 'mark_session_read', sessionId: meta.id }), 7)
    expect(result.ok).toBe(true)
    expect(unreadWrites).toHaveLength(0)
  })

  test('Given 开启态 When explicit 非字面 true（字符串 / false / 数字） Then no-op', async () => {
    modeHolder.current = 'manual'
    for (const explicit of ['true', false, 1]) {
      const result = await handleRemoteCommand(JSON.stringify({ type: 'mark_session_read', sessionId: meta.id, explicit }), 7)
      expect(result.ok).toBe(true)
    }
    expect(unreadWrites).toHaveLength(0)
  })

  test('Given 开启态 When explicit: true Then 走唯一写入口清未读', async () => {
    modeHolder.current = 'manual'
    const result = await handleRemoteCommand(JSON.stringify({ type: 'mark_session_read', sessionId: meta.id, explicit: true }), 7)
    expect(result.ok).toBe(true)
    expect(unreadWrites).toEqual([{ sessionId: meta.id, unread: false }])
  })

  test('Given 两种模式 When 缺少 sessionId / 会话不存在 Then 仍按原错误口径拒绝', async () => {
    for (const mode of ['auto', 'manual'] as AgentUnreadPolicyMode[]) {
      modeHolder.current = mode
      expect(await handleRemoteCommand(JSON.stringify({ type: 'mark_session_read' }), 7)).toEqual({ ok: false, error: '缺少 sessionId' })
      expect(await handleRemoteCommand(JSON.stringify({ type: 'mark_session_read', sessionId: 'missing', explicit: true }), 7)).toEqual({ ok: false, error: '会话不存在' })
    }
    expect(unreadWrites).toHaveLength(0)
  })
})

describe('mark_session_unread：两态一致', () => {
  test('Given 任意模式 When 显式置未读 Then 走唯一写入口写 true', async () => {
    for (const mode of ['auto', 'manual'] as AgentUnreadPolicyMode[]) {
      modeHolder.current = mode
      unreadWrites.length = 0
      const result = await handleRemoteCommand(JSON.stringify({ type: 'mark_session_unread', sessionId: meta.id }), 7)
      expect(result.ok).toBe(true)
      expect(unreadWrites).toEqual([{ sessionId: meta.id, unread: true }])
    }
  })
})

describe('toggle_session_archive：归档按模式决定是否视为已读', () => {
  test('Given 关闭态 When 归档未读会话 Then 只切 archived + 取消置顶，不写 completedButUnconfirmed', async () => {
    modeHolder.current = 'auto'
    const result = await handleRemoteCommand(JSON.stringify({ type: 'toggle_session_archive', sessionId: meta.id }), 7)
    expect(result.ok).toBe(true)
    expect(uiMetaWrites).toEqual([
      { sessionId: meta.id, updates: { archived: true } },
    ])
    expect(unreadWrites).toHaveLength(0)
  })

  test('Given 开启态 When 归档未读会话 Then 追加 completedButUnconfirmed = false（移动端归档清桌面未读保留）', async () => {
    modeHolder.current = 'manual'
    const result = await handleRemoteCommand(JSON.stringify({ type: 'toggle_session_archive', sessionId: meta.id }), 7)
    expect(result.ok).toBe(true)
    expect(uiMetaWrites).toEqual([
      { sessionId: meta.id, updates: { archived: true, completedButUnconfirmed: false } },
    ])
  })
})
