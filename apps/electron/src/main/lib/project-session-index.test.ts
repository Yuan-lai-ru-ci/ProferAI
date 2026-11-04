/**
 * P1：项目会话索引镜像与启动对账
 *
 * 锁住：
 * - project 会话的列表会写进 `<root>/.profer/sessions/index.json`；
 * - managed 会话不进入任何项目索引；
 * - 项目索引里比全局新的会话会在读取时合并回全局（项目拷来即可恢复）。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  View: {},
  WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-session-index-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  createAgentSession,
  getAgentSessionMeta,
  listAgentSessions,
  moveSessionToWorkspace,
} = await import('./agent-session-manager')
const { projectSessionIndexPath } = await import('./project-session-index')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [indexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(join(root, '.profer', 'sessions'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# project\n', 'utf-8')
  return realpathSync(root)
}

function writeWorkspaces(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function projectEntry(slug: string, rootPath: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

function managedEntry(slug: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function readProjectIndex(root: string): { sessions: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(projectSessionIndexPath(root), 'utf-8')) as { sessions: Array<Record<string, unknown>> }
}

describe('项目会话索引', () => {
  test('Given project 会话 When 创建 Then 项目索引包含该会话，managed 不写入项目索引', () => {
    const root = makeProject('p1')
    writeWorkspaces([projectEntry('p1', root), managedEntry('default')])

    const projectSession = createAgentSession('project session', undefined, 'id-p1', undefined, 'pi', false, 'standard')
    const managedSession = createAgentSession('managed session', undefined, 'id-default', undefined, 'pi', false, 'standard')

    expect(existsSync(projectSessionIndexPath(root))).toBe(true)
    const projectIndex = readProjectIndex(root)
    expect(projectIndex.sessions.map((session) => session.id)).toEqual([projectSession.id])
    expect(projectIndex.sessions[0]?.workspaceId).toBe('id-p1')

    // managed 会话仍在全局索引，且不污染项目索引
    expect(getAgentSessionMeta(managedSession.id)?.workspaceId).toBe('id-default')
    expect(projectIndex.sessions.some((session) => session.id === managedSession.id)).toBe(false)
  })

  test('Given 项目索引里有全局未知的会话 When 读取列表 Then 合并回全局并保留项目归属', () => {
    const root = makeProject('imported')
    writeWorkspaces([projectEntry('imported', root), managedEntry('default')])
    writeFileSync(projectSessionIndexPath(root), JSON.stringify({
      version: 1,
      sessions: [{
        id: 'imported-session',
        title: 'from another machine',
        workspaceId: 'stale-workspace-id',
        storageLayout: 'project',
        createdAt: 10,
        updatedAt: 20,
      }],
    }), 'utf-8')

    const sessions = listAgentSessions(true)
    const imported = sessions.find((session) => session.id === 'imported-session')

    expect(imported).toBeDefined()
    expect(imported?.workspaceId).toBe('id-imported')
    expect(imported?.title).toBe('from another machine')
  })

  test('Given 会话从项目 A 迁到项目 B When 迁移 Then A 索引移除、B 索引出现', () => {
    const rootA = makeProject('a')
    const rootB = makeProject('b')
    writeWorkspaces([projectEntry('a', rootA), projectEntry('b', rootB), managedEntry('default')])

    const session = createAgentSession('move me', undefined, 'id-a', undefined, 'pi', false, 'standard')
    expect(readProjectIndex(rootA).sessions.map((item) => item.id)).toContain(session.id)

    moveSessionToWorkspace(session.id, 'id-b')

    expect(readProjectIndex(rootA).sessions.map((item) => item.id)).not.toContain(session.id)
    expect(readProjectIndex(rootB).sessions.map((item) => item.id)).toContain(session.id)
    expect(getAgentSessionMeta(session.id)?.workspaceId).toBe('id-b')
  })
})
