/**
 * P0-A2：project 模式下的会话删除与跨工作区迁移
 *
 * 锁住两条不变量：
 * - I2：删除 project 会话只删中央 storageDir，绝不触碰 rootPath；
 * - project 参与迁移时只改索引，不 rename/rm 任何目录（历史实现会把
 *   `<rootPath>/.profer/<sessionId>` 当会话目录，属于会改写项目内路径的隐患）。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-session-delete-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { deleteAgentSession, getAgentSessionMeta, listAgentSessions, moveSessionToWorkspace, findOrphanSessions } = await import('./agent-session-manager')
const { ProjectPathDeletionError } = await import('./workspace-delete-guard')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')
const workspacesDir = join(configRoot, 'agent-workspaces')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [indexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

interface RawWorkspace {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
  type: string
  storageMode: string
  rootPath?: string
}

function projectEntry(slug: string, rootPath: string): RawWorkspace {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

function managedEntry(slug: string): RawWorkspace {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function writeWorkspacesIndex(workspaces: RawWorkspace[]): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function writeSessionsIndex(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(sessionsIndexPath), { recursive: true })
  writeFileSync(sessionsIndexPath, JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function makeProject(name: string, extraFiles: string[] = []): string {
  const root = join(sandbox, 'projects', name)
  const files = ['src/a.ts', 'package.json', '.profer/mcp.json', '.profer/sessions/.keep', ...extraFiles]
  for (const file of files) {
    const full = join(root, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content:${file}\n`, 'utf-8')
  }
  return realpathSync(root)
}

/** 项目根快照：相对路径列表（含内容长度），用于断言「一个字节都没动」。 */
function snapshotTree(root: string): string[] {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      const rel = relative(root, full)
      if (item.isDirectory()) {
        entries.push(`${rel}/`)
        walk(full)
      } else {
        entries.push(`${rel}:${readFileSync(full, 'utf-8').length}`)
      }
    }
  }
  walk(root)
  return entries.sort()
}

/** project 会话的中央 storageDir（`<config>/agent-workspaces/<slug>/sessions/<id>`）。 */
function projectStorageDir(slug: string, sessionId: string): string {
  return join(workspacesDir, slug, 'sessions', sessionId)
}

function managedStorageDir(slug: string, sessionId: string): string {
  return join(workspacesDir, slug, sessionId)
}

function seedStorageDir(dir: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n', 'utf-8')
  writeFileSync(join(dir, 'marker.txt'), 'session private data\n', 'utf-8')
}

function seedMessages(sessionId: string): string {
  const messagesPath = join(configRoot, 'agent-sessions', `${sessionId}.jsonl`)
  mkdirSync(dirname(messagesPath), { recursive: true })
  writeFileSync(messagesPath, '{"type":"user","message":{"role":"user","content":[]}}\n', 'utf-8')
  return messagesPath
}

describe('deleteAgentSession：project 会话', () => {
  test('Given project 会话 When 删除 Then 只删中央 storageDir，项目根与 .profer 完整', () => {
    const root = makeProject('session-delete')
    const before = snapshotTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-p', title: 'project session', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 }])

    const storageDir = projectStorageDir('p1', 'sess-p')
    seedStorageDir(storageDir)
    const messagesPath = seedMessages('sess-p')

    deleteAgentSession('sess-p')

    // 索引与消息被清理
    expect(getAgentSessionMeta('sess-p')).toBeUndefined()
    expect(listAgentSessions(true)).toEqual([])
    expect(existsSync(messagesPath)).toBe(false)

    // 中央 storageDir 被删
    expect(existsSync(storageDir)).toBe(false)

    // 项目根一个字节都没动（含 .profer）
    expect(existsSync(root)).toBe(true)
    expect(snapshotTree(root)).toEqual(before)
  })

  test('Given managed 会话 When 删除 Then session 目录仍在原位被删（I1 回归）', () => {
    const root = makeProject('managed-session')
    const before = snapshotTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-m', title: 'managed session', workspaceId: 'id-default', createdAt: 1, updatedAt: 1 }])

    const storageDir = managedStorageDir('default', 'sess-m')
    seedStorageDir(storageDir)

    deleteAgentSession('sess-m')

    expect(existsSync(storageDir)).toBe(false)
    expect(getAgentSessionMeta('sess-m')).toBeUndefined()
    expect(snapshotTree(root)).toEqual(before)
  })
  test('Given 索引损坏（project root 包住了会话存储）When 删会话 Then 守卫在删目录前抛错（正向控制）', () => {
    // 正常创建流程不允许 rootPath 包含配置根，但索引可被手改。
    // 这验证 `assertNotProjectLifecyclePath` 确实接在删 session 目录的链路上。
    writeWorkspacesIndex([projectEntry('bad-root', sandbox), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-bad', title: 'bad root', workspaceId: 'id-bad-root', createdAt: 1, updatedAt: 1 }])

    const storageDir = projectStorageDir('bad-root', 'sess-bad')
    seedStorageDir(storageDir)

    expect(() => deleteAgentSession('sess-bad')).toThrow(ProjectPathDeletionError)
    expect(existsSync(join(storageDir, 'marker.txt'))).toBe(true)
  })

  test('Given 项目根已被移走（rootPath 不存在）When 删会话 Then 不抛错，索引与中央 storageDir 都被清理', () => {
    // P1-6：project 的会话数据在中央 runtimeDir，与 rootPath 是否存在无关。
    // 修复前这里会因 `getAgentSessionWorkspacePath` 要求 root 存在而在索引/消息已删后抛错，
    // 留下 `sessions/<id>` 残目录。
    const root = makeProject('moved-project')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-gone', title: 'orphan root', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 }])

    const storageDir = projectStorageDir('p1', 'sess-gone')
    seedStorageDir(storageDir)
    const messagesPath = seedMessages('sess-gone')

    // 模拟项目目录被用户在 Finder 里移走 / 重命名
    rmSync(root, { recursive: true, force: true })

    expect(() => deleteAgentSession('sess-gone')).not.toThrow()

    expect(getAgentSessionMeta('sess-gone')).toBeUndefined()
    expect(listAgentSessions(true)).toEqual([])
    expect(readFileSync(sessionsIndexPath, 'utf-8')).not.toContain('sess-gone')
    expect(existsSync(messagesPath)).toBe(false)
    expect(existsSync(storageDir)).toBe(false)
    // 绝不能在 rootPath 缺失时「重建」会话目录
    expect(existsSync(projectStorageDir('p1', 'sess-gone'))).toBe(false)
  })

  test('Given 项目根已被移走 When 扫描孤儿会话 Then 不抛错，按中央目录判定工作区目录', () => {
    const root = makeProject('orphan-scan')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([
      { id: 'sess-alive', title: 'alive', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 },
      { id: 'sess-missing', title: 'missing', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 },
    ])
    seedStorageDir(projectStorageDir('p1', 'sess-alive'))
    seedMessages('sess-alive')
    seedMessages('sess-missing')

    rmSync(root, { recursive: true, force: true })

    const health = findOrphanSessions()

    expect(health.map((item) => item.sessionId).sort()).toEqual(['sess-alive', 'sess-missing'])
    expect(health.find((item) => item.sessionId === 'sess-alive')!.hasWorkspaceDir).toBe(true)
    expect(health.find((item) => item.sessionId === 'sess-missing')!.hasWorkspaceDir).toBe(false)
  })
})

describe('moveSessionToWorkspace：project 参与时只改索引', () => {
  test('Given project → project When 迁移 Then 索引更新且项目根不变、不搬迁目录', () => {
    const rootA = makeProject('move-a')
    const rootB = makeProject('move-b')
    const beforeA = snapshotTree(rootA)
    const beforeB = snapshotTree(rootB)
    writeWorkspacesIndex([projectEntry('pa', rootA), projectEntry('pb', rootB), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-1', title: 'move me', workspaceId: 'id-pa', createdAt: 1, updatedAt: 1 }])

    const sourceDir = projectStorageDir('pa', 'sess-1')
    seedStorageDir(sourceDir)

    const moved = moveSessionToWorkspace('sess-1', 'id-pb')

    expect(moved.workspaceId).toBe('id-pb')
    expect(getAgentSessionMeta('sess-1')!.workspaceId).toBe('id-pb')
    // 目录零操作：源目录原样保留（由中央存储托管，不属于项目）
    expect(existsSync(join(sourceDir, 'marker.txt'))).toBe(true)
    expect(snapshotTree(rootA)).toEqual(beforeA)
    expect(snapshotTree(rootB)).toEqual(beforeB)
  })

  test('Given project → managed When 迁移 Then 索引更新且项目根不变', () => {
    const root = makeProject('move-to-managed')
    const before = snapshotTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-2', title: 'project to managed', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 }])

    seedStorageDir(projectStorageDir('p1', 'sess-2'))

    const moved = moveSessionToWorkspace('sess-2', 'id-default')

    expect(moved.workspaceId).toBe('id-default')
    expect(snapshotTree(root)).toEqual(before)
  })

  test('Given managed → project When 迁移 Then 索引更新、项目根不变、目标存储落在中央目录', () => {
    const root = makeProject('move-to-project')
    const before = snapshotTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-3', title: 'managed to project', workspaceId: 'id-default', createdAt: 1, updatedAt: 1 }])

    seedStorageDir(managedStorageDir('default', 'sess-3'))

    const moved = moveSessionToWorkspace('sess-3', 'id-p1')

    expect(moved.workspaceId).toBe('id-p1')
    // 目标会话目录由 getAgentSessionStorageDir 在中央 runtimeDir 下重建，不进入项目
    expect(existsSync(projectStorageDir('p1', 'sess-3'))).toBe(true)
    expect(snapshotTree(root)).toEqual(before)
  })
})
