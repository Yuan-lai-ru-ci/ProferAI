/**
 * P0-A2：删除守卫 + project 工作区「移除」生命周期
 *
 * 覆盖三件事：
 * 1. `workspace-delete-guard` 两层守卫的判定（生命周期删除 / 文件浏览器删除）；
 * 2. `deleteAgentWorkspace` 的 project 分支：只删索引，项目文件、`.profer`、会话都在；
 * 3. managed 分支零变化（I1）：目录仍被删除。
 *
 * 环境隔离与 `agent-workspace-manager.index-v4.test.ts` 一致：mock electron + 临时配置根。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-delete-guard-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  ProjectPathDeletionError,
  assertNotProjectLifecyclePath,
  assertProjectFileDeletionAllowed,
} = await import('./workspace-delete-guard')
const { deleteAgentWorkspace, getAgentWorkspace, listAgentWorkspaces, readIndex } = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation, listProjectWorkspaceRoots } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(indexPath, { force: true })
  rmSync(`${indexPath}.bak`, { force: true })
  rmSync(`${indexPath}.tmp`, { force: true })
  rmSync(sessionsIndexPath, { force: true })
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
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
  storageMode?: string
  rootPath?: string
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

function projectEntry(slug: string, rootPath: string): RawWorkspace {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

function managedEntry(slug: string): RawWorkspace {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

/** 造一个带 `src/`、`.profer/` 的项目目录，返回包装信息。 */
function makeProject(name: string): { root: string; file: string } {
  const root = join(sandbox, 'projects', name)
  const file = join(root, 'src', 'a.ts')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'export const a = 1\n', 'utf-8')
  mkdirSync(join(root, '.profer', 'sessions'), { recursive: true })
  writeFileSync(join(root, '.profer', 'mcp.json'), '{"mcpServers":{}}\n', 'utf-8')
  writeFileSync(join(root, 'package.json'), '{"name":"demo"}\n', 'utf-8')
  return { root, file }
}

describe('assertNotProjectLifecyclePath', () => {
  test('Given project 工作区 When 目标是 rootPath 或其内部 Then 抛 ProjectPathDeletionError', () => {
    const project = makeProject('lifecycle')
    writeWorkspacesIndex([projectEntry('p1', project.root), managedEntry('default')])

    // macOS 的 tmpdir 在 /var 下，索引写入时已 realpath 归一化为 /private/var
    expect(listProjectWorkspaceRoots()).toEqual([{ slug: 'p1', rootPath: realpathSync(project.root) }])
    expect(() => assertNotProjectLifecyclePath(project.root)).toThrow(ProjectPathDeletionError)
    expect(() => assertNotProjectLifecyclePath(join(project.root, 'src'))).toThrow(ProjectPathDeletionError)
    expect(() => assertNotProjectLifecyclePath(join(project.root, '.profer'))).toThrow(ProjectPathDeletionError)
    expect(() => assertNotProjectLifecyclePath(project.file)).toThrow(ProjectPathDeletionError)
  })

  test('Given project 工作区 When 目标是项目外的同级目录 Then 放行', () => {
    const project = makeProject('sibling')
    writeWorkspacesIndex([projectEntry('p1', project.root), managedEntry('default')])

    expect(() => assertNotProjectLifecyclePath(join(sandbox, 'projects', 'another-project'))).not.toThrow()
    // 前缀相同但并非子路径（`projects/life` vs `projects/lifecycle`）
    expect(() => assertNotProjectLifecyclePath(`${project.root}-not-mine`)).not.toThrow()
  })

  test('Given 索引里没有 project 条目 When 任意路径 Then 放行（managed 零影响）', () => {
    writeWorkspacesIndex([managedEntry('default')])
    expect(() => assertNotProjectLifecyclePath(join(configRoot, 'agent-workspaces', 'default'))).not.toThrow()
  })
})

describe('assertProjectFileDeletionAllowed', () => {
  test('Given 项目文件 When 普通子文件 Then 允许', () => {
    const project = makeProject('files')
    writeWorkspacesIndex([projectEntry('p1', project.root), managedEntry('default')])

    expect(() => assertProjectFileDeletionAllowed(project.file, { slug: 'p1', rootPath: project.root, storageMode: 'project' })).not.toThrow()
    expect(() => assertProjectFileDeletionAllowed(join(project.root, 'src'), { slug: 'p1', rootPath: project.root, storageMode: 'project' })).not.toThrow()
    expect(() => assertProjectFileDeletionAllowed(join(project.root, '.profer', 'sessions'), { slug: 'p1', rootPath: project.root, storageMode: 'project' })).not.toThrow()
  })

  test('Given 项目根 / 根的祖先 / 整个 .profer Then 一律拒绝', () => {
    const project = makeProject('denied')
    writeWorkspacesIndex([projectEntry('p1', project.root), managedEntry('default')])
    const ref = { slug: 'p1', rootPath: project.root, storageMode: 'project' as const }

    expect(() => assertProjectFileDeletionAllowed(project.root, ref)).toThrow(ProjectPathDeletionError)
    expect(() => assertProjectFileDeletionAllowed(dirname(project.root), ref)).toThrow(ProjectPathDeletionError)
    expect(() => assertProjectFileDeletionAllowed(join(project.root, '.profer'), ref)).toThrow(ProjectPathDeletionError)
  })

  test('Given managed 工作区 When 调窄守卫 Then 拒绝（防止误用）', () => {
    expect(() => assertProjectFileDeletionAllowed(join(configRoot, 'x'), { slug: 'default', storageMode: 'managed' })).toThrow(ProjectPathDeletionError)
  })
})

describe('deleteAgentWorkspace：project 只删索引', () => {
  test('Given project 工作区含会话 When 移除 Then 索引消失、项目与 .profer 完整、会话保留', () => {
    const project = makeProject('remove')
    const messagesPath = join(configRoot, 'agent-sessions', 'sess-1.jsonl')
    mkdirSync(dirname(messagesPath), { recursive: true })
    writeFileSync(messagesPath, '{"type":"user"}\n', 'utf-8')

    writeWorkspacesIndex([projectEntry('p1', project.root), managedEntry('default')])
    writeSessionsIndex([
      { id: 'sess-1', title: 'project session', workspaceId: 'id-p1', createdAt: 1, updatedAt: 1 },
    ])

    deleteAgentWorkspace('id-p1')

    // ① 索引条目消失
    expect(getAgentWorkspace('id-p1')).toBeUndefined()
    expect(listAgentWorkspaces().map((workspace) => workspace.slug)).toEqual(['default'])
    expect(readFileSync(indexPath, 'utf-8')).not.toContain('"p1"')

    // ② 项目文件与 .profer 完整
    expect(existsSync(project.file)).toBe(true)
    expect(existsSync(join(project.root, 'package.json'))).toBe(true)
    expect(existsSync(join(project.root, '.profer', 'mcp.json'))).toBe(true)
    expect(existsSync(join(project.root, '.profer', 'sessions'))).toBe(true)

    // ③ 会话索引与消息未被级联删除
    const sessions = JSON.parse(readFileSync(sessionsIndexPath, 'utf-8')) as { sessions: Array<{ id: string; workspaceId: string }> }
    expect(sessions.sessions.map((session) => session.id)).toEqual(['sess-1'])
    expect(sessions.sessions[0]!.workspaceId).toBe('id-p1')
    expect(existsSync(messagesPath)).toBe(true)
  })

  test('Given project 工作区的 rootPath 已被拔掉 When 移除 Then 成功且不重建目录', () => {
    const root = join(sandbox, 'projects', 'unplugged')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])

    deleteAgentWorkspace('id-p1')

    expect(getAgentWorkspace('id-p1')).toBeUndefined()
    expect(existsSync(root)).toBe(false)
  })

  test('Given managed 工作区 When 删除 Then 目录被删、会话级联仍生效（I1 回归）', () => {
    const workspaceDir = join(configRoot, 'agent-workspaces', 'managed-2')
    mkdirSync(join(workspaceDir, 'skills'), { recursive: true })
    writeFileSync(join(workspaceDir, 'mcp.json'), '{}\n', 'utf-8')

    writeWorkspacesIndex([managedEntry('default'), managedEntry('managed-2')])
    writeSessionsIndex([
      { id: 'sess-m', title: 'managed session', workspaceId: 'id-managed-2', createdAt: 1, updatedAt: 1 },
    ])

    deleteAgentWorkspace('id-managed-2')

    expect(existsSync(workspaceDir)).toBe(false)
    expect(getAgentWorkspace('id-managed-2')).toBeUndefined()
    const sessions = JSON.parse(readFileSync(sessionsIndexPath, 'utf-8')) as { sessions: Array<{ id: string }> }
    expect(sessions.sessions).toEqual([])
  })

  test('Given project 是唯一剩余工作区 When 移除 Then 仍抛「至少保留一个」', () => {
    const project = makeProject('only')
    writeWorkspacesIndex([projectEntry('p1', project.root)])

    expect(() => deleteAgentWorkspace('id-p1')).toThrow('至少需要保留一个项目')
    expect(existsSync(project.file)).toBe(true)
    expect(basename(project.root)).toBe('only')
  })

  test('Given 索引损坏（project root 包住了配置目录）When 删 managed Then 兜底守卫真的会拦（正向控制）', () => {
    // 这个形态不合法（创建时就会拒绝），但索引可能被手改/旧版本写脏。
    // 断言重点：`assertNotProjectLifecyclePath` 确实接在 managed 删除链路上，而不是死代码。
    const workspaceDir = join(configRoot, 'agent-workspaces', 'managed-2')
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(join(workspaceDir, 'mcp.json'), '{}\n', 'utf-8')

    writeWorkspacesIndex([projectEntry('bad-root', sandbox), managedEntry('default'), managedEntry('managed-2')])

    expect(() => deleteAgentWorkspace('id-managed-2')).toThrow(ProjectPathDeletionError)
    // 抛错发生在任何副作用之前：索引仍在、目录仍在
    expect(getAgentWorkspace('id-managed-2')).toBeDefined()
    expect(existsSync(workspaceDir)).toBe(true)
  })
})

describe('readIndex 归一化后 project 条目仍可识别', () => {
  test('Given project 索引 When readIndex Then storageMode/rootPath 原样保留', () => {
    const project = makeProject('roundtrip')
    writeWorkspacesIndex([projectEntry('p1', project.root), managedEntry('default')])

    const index = readIndex()
    const entry = index.workspaces.find((workspace) => workspace.slug === 'p1')!
    expect(entry.storageMode).toBe('project')
    expect(entry.rootPath).toBe(project.root)
  })
})
