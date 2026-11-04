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

const { deleteAgentSession, getAgentSessionMeta, listAgentSessions, moveSessionToWorkspace, findOrphanSessions, setAgentSessionActiveChecker } = await import('./agent-session-manager')
const { ProjectPathDeletionError, assertNotProjectLifecyclePath } = await import('./workspace-delete-guard')
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

/** 项目根快照：相对路径列表（含内容长度），用于断言「用户文件一个字节都没动」。 */
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

/** 用户项目文件快照：忽略 Profer 会话目录（会话是工作区资产，不算用户文件改动）。 */
function snapshotProjectTree(root: string): string[] {
  return snapshotTree(root).filter((entry) => !entry.startsWith('.profer/sessions'))
}

/** project 会话的 storageDir（`<root>/.profer/sessions/<id>`）。 */
function projectStorageDir(slug: string, sessionId: string): string {
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
    workspaces: Array<{ slug: string; rootPath?: string }>
  }
  const rootPath = index.workspaces.find((workspace) => workspace.slug === slug)?.rootPath
  if (!rootPath) throw new Error(`project root not found: ${slug}`)
  return join(rootPath, '.profer', 'sessions', sessionId)
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
  test('Given project 会话 When 删除 Then 只删中央 storageDir，项目根与 .profer 完整', async () => {
    const root = makeProject('session-delete')
    const before = snapshotProjectTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-p', title: 'project session', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 }])

    const storageDir = projectStorageDir('p1', 'sess-p')
    seedStorageDir(storageDir)
    const messagesPath = seedMessages('sess-p')

    await deleteAgentSession('sess-p')

    // 索引与消息被清理
    expect(getAgentSessionMeta('sess-p')).toBeUndefined()
    expect(listAgentSessions(true)).toEqual([])
    expect(existsSync(messagesPath)).toBe(false)

    // 中央 storageDir 被删
    expect(existsSync(storageDir)).toBe(false)

    // 项目根一个字节都没动（含 .profer）
    expect(existsSync(root)).toBe(true)
    expect(snapshotProjectTree(root)).toEqual(before)
  })

  test('Given managed 会话 When 删除 Then session 目录仍在原位被删（I1 回归）', async () => {
    const root = makeProject('managed-session')
    const before = snapshotProjectTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-m', title: 'managed session', workspaceId: 'id-default', createdAt: 1, updatedAt: 1 }])

    const storageDir = managedStorageDir('default', 'sess-m')
    seedStorageDir(storageDir)

    await deleteAgentSession('sess-m')

    expect(existsSync(storageDir)).toBe(false)
    expect(getAgentSessionMeta('sess-m')).toBeUndefined()
    expect(snapshotProjectTree(root)).toEqual(before)
  })
  test('Given 项目路径契约 When 检查生命周期守卫 Then 会话目录放行、sessions 容器与 .profer 仍受保护', () => {
    // 会话数据已迁到项目内 `.profer/sessions/<sid>`，删会话/迁移必须能清理；
    // 但整个 sessions 容器、.profer 与项目根仍属于用户资产。
    writeWorkspacesIndex([projectEntry('bad-root', sandbox), managedEntry('default')])

    expect(() => assertNotProjectLifecyclePath(join(sandbox, '.profer', 'sessions', 'sess-bad'))).not.toThrow()
    expect(() => assertNotProjectLifecyclePath(join(sandbox, '.profer', 'sessions'))).toThrow(ProjectPathDeletionError)
    expect(() => assertNotProjectLifecyclePath(join(sandbox, '.profer'))).toThrow(ProjectPathDeletionError)
  })

  test('Given 项目根已被移走（rootPath 不存在）When 删会话 Then 不抛错，索引与中央 storageDir 都被清理', async () => {
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

    await deleteAgentSession('sess-gone')

    expect(getAgentSessionMeta('sess-gone')).toBeUndefined()
    expect(listAgentSessions(true)).toEqual([])
    expect(readFileSync(sessionsIndexPath, 'utf-8')).not.toContain('sess-gone')
    expect(existsSync(messagesPath)).toBe(false)
    expect(existsSync(storageDir)).toBe(false)
    // 绝不能在 rootPath 缺失时「重建」会话目录
    expect(existsSync(projectStorageDir('p1', 'sess-gone'))).toBe(false)
  })

  test('Given 项目根已被移走 When 扫描孤儿会话 Then 不抛错，项目内会话目录随项目消失', () => {
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
    // 会话数据在项目内，root 被移走后两个会话目录都不存在；扫描本身不能抛错。
    expect(health.find((item) => item.sessionId === 'sess-alive')!.hasWorkspaceDir).toBe(false)
    expect(health.find((item) => item.sessionId === 'sess-missing')!.hasWorkspaceDir).toBe(false)
  })
})

describe('moveSessionToWorkspace：会话目录跟随归属迁移', () => {
  test('Given project → project When 迁移 Then 索引更新、目录搬到目标项目内', () => {
    const rootA = makeProject('move-a')
    const rootB = makeProject('move-b')
    const beforeA = snapshotProjectTree(rootA)
    const beforeB = snapshotProjectTree(rootB)
    writeWorkspacesIndex([projectEntry('pa', rootA), projectEntry('pb', rootB), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-1', title: 'move me', workspaceId: 'id-pa', createdAt: 1, updatedAt: 1 }])

    const sourceDir = projectStorageDir('pa', 'sess-1')
    seedStorageDir(sourceDir)

    const moved = moveSessionToWorkspace('sess-1', 'id-pb')

    expect(moved.workspaceId).toBe('id-pb')
    expect(getAgentSessionMeta('sess-1')!.workspaceId).toBe('id-pb')
    // 目录跟着搬：源目录消失，目标项目内出现完整会话数据
    expect(existsSync(sourceDir)).toBe(false)
    expect(existsSync(join(projectStorageDir('pb', 'sess-1'), 'marker.txt'))).toBe(true)
    // 用户项目文件不变
    expect(snapshotProjectTree(rootA)).toEqual(beforeA)
    expect(snapshotProjectTree(rootB)).toEqual(beforeB)
  })

  test('Given project → managed When 迁移 Then 索引更新、目录搬到中央会话目录', () => {
    const root = makeProject('move-to-managed')
    const before = snapshotProjectTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-2', title: 'project to managed', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 }])

    const sourceDir = projectStorageDir('p1', 'sess-2')
    seedStorageDir(sourceDir)

    const moved = moveSessionToWorkspace('sess-2', 'id-default')

    expect(moved.workspaceId).toBe('id-default')
    expect(existsSync(sourceDir)).toBe(false)
    expect(existsSync(join(managedStorageDir('default', 'sess-2'), 'marker.txt'))).toBe(true)
    expect(snapshotProjectTree(root)).toEqual(before)
  })

  test('Given managed → project When 迁移 Then 索引更新、目录搬进目标项目内', () => {
    const root = makeProject('move-to-project')
    const before = snapshotProjectTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-3', title: 'managed to project', workspaceId: 'id-default', createdAt: 1, updatedAt: 1 }])

    seedStorageDir(managedStorageDir('default', 'sess-3'))

    const moved = moveSessionToWorkspace('sess-3', 'id-p1')

    expect(moved.workspaceId).toBe('id-p1')
    expect(existsSync(join(projectStorageDir('p1', 'sess-3'), 'marker.txt'))).toBe(true)
    expect(snapshotProjectTree(root)).toEqual(before)
  })

  test('Given 委派子会话 When 单独迁移 Then 拒绝，避免在目标工作区变成孤儿根', () => {
    const rootA = makeProject('move-child-a')
    const rootB = makeProject('move-child-b')
    writeWorkspacesIndex([projectEntry('pa', rootA), projectEntry('pb', rootB)])
    writeSessionsIndex([
      { id: 'sess-parent', title: 'parent', workspaceId: 'id-pa', createdAt: 1, updatedAt: 1 },
      { id: 'sess-child', title: 'child', workspaceId: 'id-pa', parentSessionId: 'sess-parent', sourceDelegationId: 'deleg-1', rootSessionId: 'sess-parent', createdAt: 2, updatedAt: 2 },
    ])
    seedStorageDir(projectStorageDir('pa', 'sess-child'))

    expect(() => moveSessionToWorkspace('sess-child', 'id-pb')).toThrow('委派子会话不能单独迁移')
    expect(getAgentSessionMeta('sess-child')!.workspaceId).toBe('id-pa')
    expect(existsSync(projectStorageDir('pa', 'sess-child'))).toBe(true)
  })

  test('Given 目标项目根不存在 When 迁移 Then 直接报错，不重建项目目录', () => {
    const root = makeProject('move-missing-root')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-missing-root', title: 'move', workspaceId: 'id-default', createdAt: 1, updatedAt: 1 }])
    seedStorageDir(managedStorageDir('default', 'sess-missing-root'))
    rmSync(root, { recursive: true, force: true })

    expect(() => moveSessionToWorkspace('sess-missing-root', 'id-p1')).toThrow()
    expect(existsSync(root)).toBe(false)
    expect(getAgentSessionMeta('sess-missing-root')!.workspaceId).toBe('id-default')
  })

  test('Given 目标项目已有同 ID 非空会话目录 When 迁移 Then 拒绝覆盖，源数据保持完整', () => {
    const root = makeProject('move-conflict')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    writeSessionsIndex([{ id: 'sess-conflict', title: 'move', workspaceId: 'id-default', createdAt: 1, updatedAt: 1 }])
    const sourceDir = managedStorageDir('default', 'sess-conflict')
    seedStorageDir(sourceDir)
    const destDir = projectStorageDir('p1', 'sess-conflict')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'existing.txt'), 'do not delete\n', 'utf-8')

    expect(() => moveSessionToWorkspace('sess-conflict', 'id-p1')).toThrow('已存在同 ID 的会话数据')
    expect(readFileSync(join(destDir, 'existing.txt'), 'utf-8')).toBe('do not delete\n')
    expect(existsSync(join(sourceDir, 'marker.txt'))).toBe(true)
    expect(getAgentSessionMeta('sess-conflict')!.workspaceId).toBe('id-default')
  })

  test('Given 委派子会话仍在运行 When 迁移父会话 Then 拒绝，不搬任何目录', () => {
    const rootA = makeProject('move-active-a')
    const rootB = makeProject('move-active-b')
    writeWorkspacesIndex([projectEntry('pa', rootA), projectEntry('pb', rootB)])
    writeSessionsIndex([
      { id: 'sess-active-parent', title: 'parent', workspaceId: 'id-pa', createdAt: 1, updatedAt: 1 },
      { id: 'sess-active-child', title: 'child', workspaceId: 'id-pa', parentSessionId: 'sess-active-parent', sourceDelegationId: 'deleg-1', rootSessionId: 'sess-active-parent', createdAt: 2, updatedAt: 2 },
    ])
    seedStorageDir(projectStorageDir('pa', 'sess-active-parent'))
    seedStorageDir(projectStorageDir('pa', 'sess-active-child'))

    setAgentSessionActiveChecker((id) => id === 'sess-active-child')
    try {
      expect(() => moveSessionToWorkspace('sess-active-parent', 'id-pb')).toThrow('正在运行或分叉')
    } finally {
      setAgentSessionActiveChecker(undefined)
    }
    expect(getAgentSessionMeta('sess-active-parent')!.workspaceId).toBe('id-pa')
    expect(existsSync(projectStorageDir('pa', 'sess-active-parent'))).toBe(true)
    expect(existsSync(projectStorageDir('pa', 'sess-active-child'))).toBe(true)
  })

  test('Given 父会话带委派子会话 When 迁移 Then 子会话与目录一起跟随，树不断', () => {
    const rootA = makeProject('move-tree-a')
    const rootB = makeProject('move-tree-b')
    writeWorkspacesIndex([projectEntry('pa', rootA), projectEntry('pb', rootB)])
    writeSessionsIndex([
      { id: 'sess-parent', title: 'parent', workspaceId: 'id-pa', createdAt: 1, updatedAt: 1 },
      { id: 'sess-child', title: 'child', workspaceId: 'id-pa', parentSessionId: 'sess-parent', sourceDelegationId: 'deleg-1', rootSessionId: 'sess-parent', createdAt: 2, updatedAt: 2 },
      { id: 'sess-grandchild', title: 'grandchild', workspaceId: 'id-pa', parentSessionId: 'sess-child', sourceDelegationId: 'deleg-2', rootSessionId: 'sess-parent', createdAt: 3, updatedAt: 3 },
    ])
    for (const id of ['sess-parent', 'sess-child', 'sess-grandchild']) {
      seedStorageDir(projectStorageDir('pa', id))
    }

    moveSessionToWorkspace('sess-parent', 'id-pb')

    for (const id of ['sess-parent', 'sess-child', 'sess-grandchild']) {
      expect(getAgentSessionMeta(id)!.workspaceId).toBe('id-pb')
      expect(existsSync(join(projectStorageDir('pb', id), 'marker.txt'))).toBe(true)
      expect(existsSync(projectStorageDir('pa', id))).toBe(false)
    }
  })
})
