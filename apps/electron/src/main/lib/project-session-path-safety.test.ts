/**
 * 修复项 2：项目会话 ID 与路径边界。
 *
 * 项目元数据来自「可能被拷贝/手工编辑过的文件夹」，ID 是不可信输入：
 * - `../`、绝对路径、分隔符、控制字符等非法 ID 必须被拒绝，不修正、不重写；
 * - sidecar 的 ID 必须与所在目录名一致；
 * - 会话目录或其祖先是指向项目外的符号链接时，导入与写入都必须失败；
 * - 被拒绝的条目不能导致项目目录外出现任何新文件。
 */
import type { AgentSessionMeta } from '@profer/shared'
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-session-paths-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  getAgentSessionMeta,
  reconcileProjectSessionIndexesNow,
} = await import('./agent-session-manager')
const {
  projectSessionIndexPath,
  readProjectSessionIndexWithDiagnostics,
  writeProjectSessionIndex,
  writeProjectSessionMeta,
} = await import('./project-session-index')
const { projectSessionMetaPath } = await import('./project-session-index')
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
  rmSync(join(sandbox, 'outside'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(join(root, '.profer', 'sessions'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# project\n', 'utf-8')
  return realpathSync(root)
}

function makeOutside(): string {
  const dir = join(sandbox, 'outside')
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
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

function meta(id: string, extra: Record<string, unknown> = {}): AgentSessionMeta & Record<string, unknown> {
  return { id, title: `session ${id}`, workspaceId: 'stale', storageLayout: 'project', createdAt: 1, updatedAt: 2, ...extra } as AgentSessionMeta & Record<string, unknown>
}

describe('项目会话 ID 校验', () => {
  test('Given 索引含穿越/绝对路径/分隔符 ID When 对账 Then 全部拒绝且项目外无新文件', () => {
    const root = makeProject('ids')
    const outside = makeOutside()
    writeWorkspaces([projectEntry('ids', root)])
    writeSessions([])
    writeProjectIndex(root, [
      meta('../escaped'),
      meta('../../outside/pwn'),
      meta('/tmp/absolute-pwn'),
      meta('nested/child'),
      meta('nested\\child'),
      meta('..'),
      meta(''),
      meta('ok-session-1'),
    ])

    // 读取阶段就把非法条目摘出来（不修正 ID）
    const diagnostics = readProjectSessionIndexWithDiagnostics(root)
    expect(diagnostics.rejected).toHaveLength(7)
    expect(diagnostics.sessions.map((session) => session.id)).toEqual(['ok-session-1'])

    reconcileProjectSessionIndexesNow()

    for (const badId of ['../escaped', '../../outside/pwn', '/tmp/absolute-pwn', 'nested/child', 'nested\\child', '..', '']) {
      expect(getAgentSessionMeta(badId)).toBeUndefined()
    }
    // 合法条目仍可导入（控制组）
    expect(getAgentSessionMeta('ok-session-1')?.workspaceId).toBe('id-ids')

    // 项目目录外不产生任何会话文件
    expect(existsSync(join(root, 'escaped'))).toBe(false)
    expect(existsSync(join(root, '..', 'escaped'))).toBe(false)
    expect(existsSync(join(outside, 'pwn'))).toBe(false)
    expect(existsSync('/tmp/absolute-pwn')).toBe(false)
    expect(existsSync(join(root, '.profer', 'sessions', 'nested'))).toBe(false)

    // 对账后项目镜像只剩合法条目
    const persisted = readProjectSessionIndexWithDiagnostics(root)
    expect(persisted.sessions.map((session) => session.id)).toEqual(['ok-session-1'])
    expect(persisted.rejected).toEqual([])
  })

  test('Given sidecar ID 与目录名不一致 When 对账 Then 不使用该 sidecar 内容', () => {
    const root = makeProject('mismatch')
    writeWorkspaces([projectEntry('mismatch', root)])
    writeSessions([])
    const dataDir = join(root, '.profer', 'sessions', 'dir-name-1')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'session.json'), JSON.stringify(meta('other-id-1', { title: '冒名会话' })), 'utf-8')
    writeFileSync(join(dataDir, 'messages.jsonl'), '{"type":"user"}\n', 'utf-8')

    reconcileProjectSessionIndexesNow()

    expect(getAgentSessionMeta('other-id-1')).toBeUndefined()
    expect(getAgentSessionMeta('dir-name-1')).toBeUndefined()
  })

  test('Given 会话目录是指向项目外的符号链接 When 导入 Then 拒绝且不写入项目外', () => {
    const root = makeProject('symlink-dir')
    const outside = makeOutside()
    writeWorkspaces([projectEntry('symlink-dir', root)])
    writeSessions([])
    writeProjectIndex(root, [meta('linked-1')])
    const outsideSession = join(outside, 'linked-1')
    mkdirSync(outsideSession, { recursive: true })
    writeFileSync(join(outsideSession, 'messages.jsonl'), '{"type":"user"}\n', 'utf-8')
    symlinkSync(outsideSession, join(root, '.profer', 'sessions', 'linked-1'))

    reconcileProjectSessionIndexesNow()

    expect(getAgentSessionMeta('linked-1')).toBeUndefined()
    expect(existsSync(join(outsideSession, 'session.json'))).toBe(false)
  })

  test('Given index.json 是指向项目外的符号链接 When 读写项目索引 Then 拒绝读写外部文件', () => {
    const root = makeProject('symlink-index')
    const outside = makeOutside()
    writeWorkspaces([projectEntry('symlink-index', root)])
    writeSessions([])
    const outsideIndex = join(outside, 'index.json')
    writeFileSync(outsideIndex, JSON.stringify({ version: 1, sessions: [meta('outside-1')] }), 'utf-8')
    symlinkSync(outsideIndex, projectSessionIndexPath(root))

    const diagnostics = readProjectSessionIndexWithDiagnostics(root)
    expect(diagnostics.sessions).toEqual([])
    expect(diagnostics.rejected[0]?.reason).toContain('索引文件路径')
    expect(() => writeProjectSessionIndex(root, [meta('would-write')])).toThrow()
    expect(readFileSync(outsideIndex, 'utf-8')).toContain('outside-1')
  })
  test('Given .profer/sessions 指向项目外 When 扫描与写入 Then 全部跳过', () => {
    const root = join(sandbox, 'projects', 'symlink-root')
    mkdirSync(join(root, '.profer'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# project\n', 'utf-8')
    const outside = makeOutside()
    mkdirSync(join(outside, 'sessions', 'outside-1'), { recursive: true })
    writeFileSync(join(outside, 'sessions', 'outside-1', 'messages.jsonl'), '{"type":"user"}\n', 'utf-8')
    symlinkSync(join(outside, 'sessions'), join(root, '.profer', 'sessions'))

    writeWorkspaces([projectEntry('symlink-root', root)])
    writeSessions([])

    reconcileProjectSessionIndexesNow()

    expect(getAgentSessionMeta('outside-1')).toBeUndefined()
    expect(existsSync(join(outside, 'sessions', 'outside-1', 'session.json'))).toBe(false)
  })

  test('Given 会话根指向项目内目录的符号链接 When 导入 Then 允许', () => {
    const root = join(sandbox, 'projects', 'inner-link')
    mkdirSync(join(root, '.profer'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# project\n', 'utf-8')
    const realSessions = join(root, 'real-sessions')
    mkdirSync(join(realSessions, 'inner-1'), { recursive: true })
    writeFileSync(join(realSessions, 'inner-1', 'messages.jsonl'), '{"type":"user"}\n', 'utf-8')
    symlinkSync(realSessions, join(root, '.profer', 'sessions'))

    writeWorkspaces([projectEntry('inner-link', root)])
    writeSessions([])

    reconcileProjectSessionIndexesNow()

    expect(getAgentSessionMeta('inner-1')?.workspaceId).toBe('id-inner-link')
    expect(existsSync(join(realSessions, 'inner-1', 'session.json'))).toBe(true)
  })

  test('Given 非法 ID 或逃逸路径 When 写 sidecar Then 抛错且不落盘', () => {
    const root = makeProject('write-guard')
    const outside = makeOutside()
    const target = join(outside, 'escape-1')
    mkdirSync(target, { recursive: true })
    symlinkSync(target, join(root, '.profer', 'sessions', 'escape-1'))

    expect(() => projectSessionMetaPath(root, '../escape-1')).toThrow()
    expect(() => projectSessionMetaPath(root, 'a/b')).toThrow()
    expect(() => writeProjectSessionMeta(root, 'escape-1', meta('escape-1') as never)).toThrow()

    // 目录名与 ID 不一致同样拒绝
    expect(() => writeProjectSessionMeta(root, 'dir-2', meta('other-2') as never)).toThrow()
    expect(existsSync(join(target, 'session.json'))).toBe(false)

    // 合法写入正常
    writeProjectSessionMeta(root, 'ok-2', meta('ok-2') as never)
    expect(JSON.parse(readFileSync(projectSessionMetaPath(root, 'ok-2'), 'utf-8'))).toMatchObject({ id: 'ok-2' })
  })
})
