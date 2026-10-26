/**
 * 「状态切换不算活跃」的回归测试。
 *
 * 侧栏「最近」排序按项目内最新会话的 `updatedAt` 决定项目顺序；行内时间也读同一个字段。
 * 置顶 / 归档这类纯展示状态切换若刷新 `updatedAt`，用户置顶一条旧会话就会让整个项目
 * 凭空跳到最上面、时间显示成「刚刚」。这里锁住 `touchUpdatedAt: false` 的语义：
 * 写入落盘、revision 递增，但 updatedAt 保持原值。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 会话/对话管理器经 workspace 服务间接导入 Electron；Bun 单测需提供最小主进程 mock。
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

let root = ''
let sessions: typeof import('./agent-session-manager')
let conversations: typeof import('./conversation-manager')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-meta-touch-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?meta-touch-test=${cacheKey}`)
  conversations = await import(`./conversation-manager?meta-touch-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('updateAgentSessionMeta — 状态切换不刷新 updatedAt', () => {
  test('置顶：updatedAt 保持不变，pinned 正常落盘', async () => {
    const meta = sessions.createAgentSession('旧会话', undefined, undefined, undefined, 'claude')
    await sleep(5)
    const before = sessions.getAgentSessionMeta(meta.id)!

    const updated = sessions.updateAgentSessionMeta(meta.id, { pinned: true }, { touchUpdatedAt: false })

    expect(updated.pinned).toBe(true)
    expect(updated.updatedAt).toBe(before.updatedAt)
    expect(sessions.getAgentSessionMeta(meta.id)!.updatedAt).toBe(before.updatedAt)
  })

  test('归档与取消归档：updatedAt 都保持不变', async () => {
    const meta = sessions.createAgentSession('待归档会话', undefined, undefined, undefined, 'claude')
    await sleep(5)
    const before = sessions.getAgentSessionMeta(meta.id)!

    const archived = sessions.updateAgentSessionMeta(meta.id, { archived: true }, { touchUpdatedAt: false })
    expect(archived.archived).toBe(true)
    expect(archived.updatedAt).toBe(before.updatedAt)

    const restored = sessions.updateAgentSessionMeta(meta.id, { archived: false }, { touchUpdatedAt: false })
    expect(restored.archived).toBe(false)
    expect(restored.updatedAt).toBe(before.updatedAt)
  })

  test('默认写入仍然刷新 updatedAt（内容更新照常参与排序）', async () => {
    const meta = sessions.createAgentSession('普通会话', undefined, undefined, undefined, 'claude')
    const before = sessions.getAgentSessionMeta(meta.id)!
    await sleep(5)

    const updated = sessions.updateAgentSessionMeta(meta.id, { title: '改了标题' })

    expect(updated.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  test('状态切换仍递增 revision，UI 能感知变化', () => {
    const meta = sessions.createAgentSession('置顶会话', undefined, undefined, undefined, 'claude')
    const before = sessions.getAgentSessionMeta(meta.id)!

    const updated = sessions.updateAgentSessionMeta(meta.id, { pinned: true }, { touchUpdatedAt: false })

    expect(updated.revision).toBeGreaterThan(before.revision ?? 0)
  })
})

describe('updateConversationMeta — 状态切换不刷新 updatedAt', () => {
  const readConversation = (id: string) => conversations.listConversations(true).find((item) => item.id === id)!

  test('置顶与归档：updatedAt 保持不变', async () => {
    const meta = conversations.createConversation('旧对话')
    await sleep(5)
    const before = readConversation(meta.id)

    const pinned = conversations.updateConversationMeta(meta.id, { pinned: true }, { touchUpdatedAt: false })
    expect(pinned.pinned).toBe(true)
    expect(pinned.updatedAt).toBe(before.updatedAt)

    const archived = conversations.updateConversationMeta(meta.id, { archived: true }, { touchUpdatedAt: false })
    expect(archived.archived).toBe(true)
    expect(archived.updatedAt).toBe(before.updatedAt)
  })

  test('默认写入仍然刷新 updatedAt', async () => {
    const meta = conversations.createConversation('普通对话')
    const before = readConversation(meta.id)
    await sleep(5)

    const updated = conversations.updateConversationMeta(meta.id, { title: '改了标题' })

    expect(updated.updatedAt).toBeGreaterThan(before.updatedAt)
  })
})
