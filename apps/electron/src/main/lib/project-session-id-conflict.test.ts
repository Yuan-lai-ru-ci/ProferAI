/**
 * 修复项 1：跨项目同 ID 会话冲突必须被拒绝，不能静默抢占归属。
 *
 * 锁住：
 * - 同一会话 ID 已属于项目 A 时，项目 B（整目录拷贝/备份）不能按 updatedAt 改写归属；
 * - 双方项目索引与会话目录都保留，冲突可被诊断；
 * - 同一项目内的 updatedAt 合并逻辑不受影响。
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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-session-conflict-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  getAgentSessionMeta,
  listAgentSessions,
  listProjectSessionIndexConflicts,
  reconcileProjectSessionIndexesNow,
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

function writeSessions(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(sessionsIndexPath), { recursive: true })
  writeFileSync(sessionsIndexPath, JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function writeProjectIndex(root: string, sessions: Array<Record<string, unknown>>): void {
  const target = projectSessionIndexPath(root)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function readProjectIndex(root: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(readFileSync(projectSessionIndexPath(root), 'utf-8')) as { sessions: Array<Record<string, unknown>> }
  return parsed.sessions
}

describe('跨项目会话 ID 冲突', () => {
  test('Given 同一 ID 已属于项目 A When 项目 B 有更新的副本 Then A 归属不被改写、双方索引都保留', () => {
    const rootA = makeProject('a')
    const rootB = makeProject('b')
    writeWorkspaces([projectEntry('a', rootA), projectEntry('b', rootB)])
    writeSessions([{
      id: 'shared-1', title: 'A 的会话', workspaceId: 'id-a', storageLayout: 'project', createdAt: 1, updatedAt: 100,
    }])
    writeProjectIndex(rootA, [{
      id: 'shared-1', title: 'A 的会话', workspaceId: 'id-a', storageLayout: 'project', createdAt: 1, updatedAt: 100,
    }])
    writeProjectIndex(rootB, [{
      id: 'shared-1', title: 'B 的副本', workspaceId: 'id-b', storageLayout: 'project', createdAt: 1, updatedAt: 9999,
    }])
    // B 还带着会话目录与 sidecar：拷贝过来的数据必须原样保留
    const bSessionDir = join(rootB, '.profer', 'sessions', 'shared-1')
    mkdirSync(bSessionDir, { recursive: true })
    writeFileSync(join(bSessionDir, 'session.json'), JSON.stringify({
      id: 'shared-1', title: 'B 的副本', workspaceId: 'id-b', storageLayout: 'project', createdAt: 1, updatedAt: 9999,
    }), 'utf-8')
    writeFileSync(join(bSessionDir, 'messages.jsonl'), '{"type":"user"}\n', 'utf-8')

    reconcileProjectSessionIndexesNow()

    const meta = getAgentSessionMeta('shared-1')
    expect(meta?.workspaceId).toBe('id-a')
    expect(meta?.title).toBe('A 的会话')

    // 项目 A 的镜像不能因为“归属被改走”而清空
    expect(readProjectIndex(rootA).map((session) => session.id)).toEqual(['shared-1'])
    // 项目 B 的镜像保留冲突证据，且会话目录不被改写
    expect(readProjectIndex(rootB).map((session) => session.id)).toEqual(['shared-1'])
    expect(JSON.parse(readFileSync(join(bSessionDir, 'session.json'), 'utf-8'))).toMatchObject({ workspaceId: 'id-b', title: 'B 的副本' })

    expect(listProjectSessionIndexConflicts()).toEqual([{
      sessionId: 'shared-1',
      rootPath: rootB,
      workspaceId: 'id-a',
      conflictingWorkspaceId: 'id-b',
      title: 'B 的副本',
    }])
    // 全局索引里仍然只有一条
    expect(listAgentSessions().filter((session) => session.id === 'shared-1')).toHaveLength(1)
  })

  test('Given 新机器上两个项目都有同一 ID When 对账 Then 只导入第一个项目，第二个记为冲突', () => {
    const rootC = makeProject('c')
    const rootD = makeProject('d')
    writeWorkspaces([projectEntry('c', rootC), projectEntry('d', rootD)])
    writeSessions([])
    writeProjectIndex(rootC, [{
      id: 'dup-1', title: 'C 副本', workspaceId: 'id-c', storageLayout: 'project', createdAt: 1, updatedAt: 50,
    }])
    writeProjectIndex(rootD, [{
      id: 'dup-1', title: 'D 副本', workspaceId: 'id-d', storageLayout: 'project', createdAt: 1, updatedAt: 60,
    }])

    reconcileProjectSessionIndexesNow()

    const meta = getAgentSessionMeta('dup-1')
    expect(meta?.workspaceId).toBe('id-c')
    expect(listProjectSessionIndexConflicts().map((conflict) => conflict.rootPath)).toEqual([rootD])
    expect(readProjectIndex(rootD).map((session) => session.id)).toEqual(['dup-1'])

    // 冲突消失后诊断被清理，不会永久告警
    writeProjectIndex(rootD, [])
    reconcileProjectSessionIndexesNow()
    expect(listProjectSessionIndexConflicts()).toEqual([])
    expect(getAgentSessionMeta('dup-1')?.workspaceId).toBe('id-c')
  })

  test('Given 同一项目内索引比全局新 When 对账 Then 仍按 updatedAt 合并', () => {
    const rootE = makeProject('e')
    writeWorkspaces([projectEntry('e', rootE)])
    writeSessions([{
      id: 'local-1', title: '旧标题', workspaceId: 'id-e', storageLayout: 'project', createdAt: 1, updatedAt: 100,
    }])
    writeProjectIndex(rootE, [{
      id: 'local-1', title: '新标题', workspaceId: 'id-e', storageLayout: 'project', createdAt: 1, updatedAt: 500,
    }])

    reconcileProjectSessionIndexesNow()

    expect(getAgentSessionMeta('local-1')?.title).toBe('新标题')
    expect(listProjectSessionIndexConflicts()).toEqual([])
    expect(existsSync(join(rootE, '.profer', 'sessions', 'index.json'))).toBe(true)
  })
})
