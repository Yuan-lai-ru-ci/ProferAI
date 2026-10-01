import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import * as actualSessionManager from './agent-session-manager'
import type { AgentUnreadPolicyMode } from './agent-unread-policy'

/**
 * F-3 回归（验收缺陷修复）：未读唯一写入口 `setAgentSessionUnread` 的「归档副效应」必须按模式分支。
 *
 * 缺陷是：写入口无条件携带 `archived: true`，抑制了 `updateAgentSessionMeta` 既有的自动解归档
 * ⇒ 关闭态下「打开/关闭带持久化未读的归档会话」「菜单切换」「移动端标记已读」不再把会话拉回
 * 活跃列表（基线会），这是关闭态一处未登记的差异。
 *
 * 覆盖点（自写用例）：
 * 1. 关闭态（auto）：写未读时**不携带** `archived` ⇒ 自动解归档照旧生效（原副效应恢复）；
 * 2. 开启态（manual）：写未读时携带 `archived: true` ⇒ 归档会话不被拉回活跃列表；
 * 3. 未归档会话两种模式都不带 `archived`；
 * 4. 会话不存在时返回 null 且不做任何写入（幂等不复活已删除会话）；
 * 5. 结构守卫：依赖的 autoUnarchive 判据仍在 `agent-session-manager.ts` 里。
 *
 * 验证方式：mock 会话读取与模式取值，走**真实的** `setAgentSessionUnread`（唯一写入口），
 * 断言它真正交给元数据层的 updates。
 */

const metaHolder: { current: AgentSessionMeta } = { current: archivedSession(false) }
const metaWrites: Array<{ id: string; updates: Record<string, unknown> }> = []
const modeHolder: { current: AgentUnreadPolicyMode } = { current: 'auto' }

function archivedSession(archived: boolean): AgentSessionMeta {
  return {
    id: 'session-under-test',
    title: '归档未读会话',
    createdAt: 1,
    updatedAt: 2,
    revision: 7,
    archived,
    pinned: false,
    completedButUnconfirmed: true,
  } as AgentSessionMeta
}

mock.module('./agent-session-manager', () => ({
  ...actualSessionManager,
  getAgentSessionMeta: (id: string) => (id === metaHolder.current.id ? { ...metaHolder.current } : undefined),
  updateAgentSessionMeta: (id: string, updates: Record<string, unknown>) => {
    metaWrites.push({ id, updates })
    // 模拟元数据层既有的自动解归档规则（真实规则由 agent-session-manager.ts 的结构守卫锁定）：
    // 已归档 + 未显式携带 archived ⇒ 拉回活跃列表。这正是关闭态要恢复的副效应。
    const autoUnarchive = metaHolder.current.archived === true && !('archived' in updates)
    metaHolder.current = { ...metaHolder.current, ...updates, ...(autoUnarchive ? { archived: false } : {}) }
    return metaHolder.current
  },
}))

mock.module('./agent-unread-mode', () => ({
  getAgentUnreadPolicyMode: () => modeHolder.current,
}))

type PublisherModule = typeof import('./agent-session-ui-projection-publisher')
let publisher: PublisherModule

beforeEach(async () => {
  modeHolder.current = 'auto'
  metaWrites.length = 0
  metaHolder.current = archivedSession(true)
  publisher ??= await import('./agent-session-ui-projection-publisher')
  // projection 广播需要一个事件总线；本用例只关心交给元数据层的 updates。
  publisher.configureAgentSessionProjectionPublisher({ emit: () => {} } as never)
})

describe('关闭态：恢复既有的自动解归档副效应', () => {
  test('Given 已归档且未读的会话 When 关闭态写未读 Then 不携带 archived（让 updateAgentSessionMeta 自动解归档）', () => {
    const updated = publisher.setAgentSessionUnread(metaHolder.current.id, false)
    expect(updated).not.toBeNull()
    expect(metaWrites).toHaveLength(1)
    expect(metaWrites[0]!.updates).toEqual({ completedButUnconfirmed: false })
    expect('archived' in metaWrites[0]!.updates).toBe(false)
    expect(updated?.archived).toBe(false)
  })

  test('Given 已归档且未读的会话 When 关闭态标记未读 Then 同样不携带 archived', () => {
    publisher.setAgentSessionUnread(metaHolder.current.id, true)
    expect(metaWrites[0]!.updates).toEqual({ completedButUnconfirmed: true })
    expect('archived' in metaWrites[0]!.updates).toBe(false)
  })
})

describe('开启态：归档会话不被未读变更拉回活跃列表', () => {
  test('Given 已归档且未读的会话 When 开启态写未读 Then 显式保持 archived: true', () => {
    modeHolder.current = 'manual'
    const updated = publisher.setAgentSessionUnread(metaHolder.current.id, false)
    expect(metaWrites[0]!.updates).toEqual({ completedButUnconfirmed: false, archived: true })
    expect(updated?.archived).toBe(true)
  })
  test('Given 已归档且未读的会话 When 开启态标记未读 Then 同样保持 archived: true', () => {
    modeHolder.current = 'manual'
    publisher.setAgentSessionUnread(metaHolder.current.id, true)
    expect(metaWrites[0]!.updates).toEqual({ completedButUnconfirmed: true, archived: true })
  })
})

describe('未归档会话与幂等', () => {
  test('Given 未归档会话 When 两种模式写未读 Then 都不携带 archived 字段', () => {
    for (const mode of ['auto', 'manual'] as AgentUnreadPolicyMode[]) {
      modeHolder.current = mode
      metaWrites.length = 0
      metaHolder.current = archivedSession(false)
      publisher.setAgentSessionUnread(metaHolder.current.id, false)
      expect(metaWrites[0]!.updates).toEqual({ completedButUnconfirmed: false })
    }
  })

  test('Given 会话不存在 When 写未读 Then 返回 null 且没有任何写入（迟到调用不复活已删除会话）', () => {
    const result = publisher.setAgentSessionUnread('missing-session', true)
    expect(result).toBeNull()
    expect(metaWrites).toHaveLength(0)
  })

  test('Given 开启态写未读 When 同时带配套字段 Then 配套字段与未读同事务落盘', () => {
    modeHolder.current = 'manual'
    publisher.setAgentSessionUnread(metaHolder.current.id, false, { manualWorking: false })
    expect(metaWrites[0]!.updates).toEqual({
      manualWorking: false,
      completedButUnconfirmed: false,
      archived: true,
    })
  })
})

describe('结构守卫：关闭态依赖的自动解归档判据仍在', () => {
  test('Given 关闭态靠「未显式携带 archived」触发解归档 When 检查会话元数据层 Then autoUnarchive 判据保留', async () => {
    const source = (await Bun.file(join(import.meta.dir, 'agent-session-manager.ts')).text()).replace(/\r\n/g, '\n')
    expect(source).toContain("const autoUnarchive = existing.archived && !('archived' in updates) && !isStoppedByUserOnly")
    expect(source).toContain('...(autoUnarchive ? { archived: false } : {})')
  })
})
