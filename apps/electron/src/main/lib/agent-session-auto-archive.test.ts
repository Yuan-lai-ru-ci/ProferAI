/**
 * Agent 会话自动归档：工作区保留名额 + 保护规则
 *
 * 覆盖：
 * - 每个工作区按最后活跃时间保留最近 N 个，超出且超时才归档
 * - 置顶、运行中、有未完成任务图节点的会话豁免
 * - 定时任务/委派子会话不占名额，仍按时间阈值归档
 * - keep=0 回到纯时间阈值
 *
 * 环境隔离方式与 agent-workspace-archive.test.ts 一致：mock electron + 临时配置根。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const configRoot = join(tmpdir(), `profer-auto-archive-${Date.now()}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { autoArchiveAgentSessions, setAgentSessionActiveChecker } = await import('./agent-session-manager')
const { getAgentSessionsDir, getAgentSessionsIndexPath } = await import('./config-paths')
const { getGraphJsonlPath, serializeEvent } = await import('@profer/project-core')
type AgentSessionMeta = import('@profer/shared').AgentSessionMeta

const DAY = 86_400_000
let mtimeTick = 0

afterAll(() => {
  setAgentSessionActiveChecker(undefined)
  rmSync(configRoot, { recursive: true, force: true })
})

beforeEach(() => {
  setAgentSessionActiveChecker(undefined)
  mtimeTick += 1
  rmSync(configRoot, { recursive: true, force: true })
})

function session(overrides: Partial<AgentSessionMeta> & { id: string }): AgentSessionMeta {
  const now = Date.now()
  return {
    title: overrides.id,
    createdAt: now - 30 * DAY,
    updatedAt: now - 10 * DAY,
    workspaceId: 'ws-1',
    ...overrides,
  }
}

/** 写入索引文件；强制推进 mtime，避免索引缓存把用例间写入当成同一次读取。 */
function writeSessions(sessions: AgentSessionMeta[]): void {
  const path = getAgentSessionsIndexPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, sessions }, null, 2))
  mtimeTick += 1
  const stamp = new Date(Date.now() + mtimeTick * 1000)
  utimesSync(path, stamp, stamp)
}

/** 直接读磁盘上的索引，断言归档结果不依赖内存对象。 */
function archivedIds(): string[] {
  const raw = JSON.parse(readFileSync(getAgentSessionsIndexPath(), 'utf-8')) as { sessions: AgentSessionMeta[] }
  return raw.sessions.filter((item) => item.archived).map((item) => item.id).sort()
}

/** 给会话写一条任务图事件；status 省略时为 pending。 */
function writeGraph(sessionId: string, status?: 'pending' | 'in_progress' | 'completed'): void {
  const path = getGraphJsonlPath(getAgentSessionsDir(), sessionId)
  mkdirSync(dirname(path), { recursive: true })
  const events = [
    { type: 'task_created' as const, taskId: 't1', timestamp: Date.now(), payload: { subject: '任务', description: '', dependsOn: [] } },
    ...(status
      ? [{ type: 'task_status_changed' as const, taskId: 't1', timestamp: Date.now() + 1, payload: { newStatus: status } }]
      : []),
  ]
  writeFileSync(path, events.map(serializeEvent).join('\n') + '\n')
}

describe('Agent 会话自动归档', () => {
  test('每个工作区保留最近 3 个，其余超时会话被归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-1', updatedAt: now - 40 * DAY }),
      session({ id: 'sess-2', updatedAt: now - 30 * DAY }),
      session({ id: 'sess-3', updatedAt: now - 20 * DAY }),
      session({ id: 'sess-4', updatedAt: now - 10 * DAY }),
      session({ id: 'sess-5', updatedAt: now - 2 * DAY }),
    ])

    expect(autoArchiveAgentSessions(7, 3)).toBe(2)
    expect(archivedIds()).toEqual(['sess-1', 'sess-2'])
  })

  test('不同工作区各自保留名额，互不挤占', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'ws1-a', workspaceId: 'ws-1', updatedAt: now - 40 * DAY }),
      session({ id: 'ws1-b', workspaceId: 'ws-1', updatedAt: now - 30 * DAY }),
      session({ id: 'ws2-a', workspaceId: 'ws-2', updatedAt: now - 40 * DAY }),
      session({ id: 'ws2-b', workspaceId: 'ws-2', updatedAt: now - 30 * DAY }),
    ])

    // 每个工作区只留 1 个：各归档 1 个，而不是让 ws-1 的两个都归档
    expect(autoArchiveAgentSessions(7, 1)).toBe(2)
    expect(archivedIds()).toEqual(['ws1-a', 'ws2-a'])
  })

  test('置顶与运行中的会话不被归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-new', updatedAt: now - DAY }),
      session({ id: 'sess-pinned', updatedAt: now - 60 * DAY, pinned: true }),
      session({ id: 'sess-running', updatedAt: now - 60 * DAY }),
    ])
    setAgentSessionActiveChecker((id) => id === 'sess-running')

    expect(autoArchiveAgentSessions(7, 1)).toBe(0)
    expect(archivedIds()).toEqual([])
  })

  test('任务图仍有未完成节点时跳过，全部完成才归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-keep', updatedAt: now - DAY }),
      session({ id: 'sess-pending', updatedAt: now - 60 * DAY }),
      session({ id: 'sess-in-progress', updatedAt: now - 55 * DAY }),
      session({ id: 'sess-done', updatedAt: now - 50 * DAY }),
    ])
    writeGraph('sess-pending')
    writeGraph('sess-in-progress', 'in_progress')
    writeGraph('sess-done', 'completed')

    expect(autoArchiveAgentSessions(7, 1)).toBe(1)
    expect(archivedIds()).toEqual(['sess-done'])
  })

  test('子会话残留的置顶字段不豁免自动归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-user-new', updatedAt: now - DAY }),
      session({
        id: 'sess-delegated-pinned',
        updatedAt: now - 60 * DAY,
        pinned: true,
        parentSessionId: 'sess-user-new',
        sourceDelegationId: 'd-1',
      }),
    ])

    expect(autoArchiveAgentSessions(7, 1)).toBe(1)
    expect(archivedIds()).toEqual(['sess-delegated-pinned'])
  })

  test('定时任务与委派子会话不占保留名额，仍按时间阈值归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-user-old', updatedAt: now - 40 * DAY }),
      session({ id: 'sess-user-new', updatedAt: now - 2 * DAY }),
      session({ id: 'sess-auto-1', updatedAt: now - 40 * DAY, sourceAutomationId: 'auto-1' }),
      session({ id: 'sess-auto-2', updatedAt: now - 35 * DAY, sourceAutomationId: 'auto-1' }),
      session({ id: 'sess-delegated', updatedAt: now - 30 * DAY, parentSessionId: 'sess-user-new', sourceDelegationId: 'd-1' }),
    ])

    // 名额留给两个用户会话；三个系统产物按时间阈值全部归档
    expect(autoArchiveAgentSessions(7, 2)).toBe(3)
    expect(archivedIds()).toEqual(['sess-auto-1', 'sess-auto-2', 'sess-delegated'])
  })

  test('keep=0 回到纯时间阈值', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-1', updatedAt: now - 40 * DAY }),
      session({ id: 'sess-2', updatedAt: now - 30 * DAY }),
      session({ id: 'sess-3', updatedAt: now - 2 * DAY }),
    ])

    expect(autoArchiveAgentSessions(7, 0)).toBe(2)
    expect(archivedIds()).toEqual(['sess-1', 'sess-2'])
  })

  test('未超出保留名额的会话即使很旧也不归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-1', updatedAt: now - 400 * DAY }),
      session({ id: 'sess-2', updatedAt: now - 300 * DAY }),
      session({ id: 'sess-3', updatedAt: now - 200 * DAY }),
      session({ id: 'sess-4', updatedAt: now - 100 * DAY }),
    ])

    expect(autoArchiveAgentSessions(7, 3)).toBe(1)
    expect(archivedIds()).toEqual(['sess-1'])
  })

  test('草稿会话不参与归档', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-real', updatedAt: now - DAY }),
      session({ id: 'sess-draft', updatedAt: now - 90 * DAY, draft: true }),
    ])

    expect(autoArchiveAgentSessions(7, 1)).toBe(0)
    expect(archivedIds()).toEqual([])
  })

  test('已归档会话不重复计数，也不占用保留名额', () => {
    const now = Date.now()
    writeSessions([
      session({ id: 'sess-1', updatedAt: now - DAY }),
      session({ id: 'sess-2', updatedAt: now - 40 * DAY, archived: true }),
      session({ id: 'sess-3', updatedAt: now - 50 * DAY }),
    ])

    expect(autoArchiveAgentSessions(7, 1)).toBe(1)
    expect(archivedIds()).toEqual(['sess-2', 'sess-3'])
  })
})
