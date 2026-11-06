/**
 * P4：存量 project 会话布局迁移与回滚
 *
 * 覆盖：
 * - 中央 messages/graph/harness/transcript 搬进项目；
 * - storageLayout 标记与 piSessionFile 更新；
 * - 运行中的会话跳过、可重跑；
 * - 回滚把文件搬回中央并清除项目索引/标记。
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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-layout-migration-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  getAgentSessionMeta,
  migrateProjectSessionLayouts,
  rollbackProjectSessionLayouts,
  setAgentSessionActiveChecker,
} = await import('./agent-session-manager')
const { projectSessionIndexPath } = await import('./project-session-index')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')
const globalSessionsDir = join(configRoot, 'agent-sessions')
const globalPiDir = join(configRoot, 'sdk-config', 'sessions', 'pi')

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
  rmSync(globalSessionsDir, { recursive: true, force: true })
  rmSync(join(configRoot, 'sdk-config'), { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  setAgentSessionActiveChecker(undefined)
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

function writeSessions(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(sessionsIndexPath), { recursive: true })
  writeFileSync(sessionsIndexPath, JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function seedGlobalFiles(sessionId: string, sdkSessionId?: string): { transcript?: string } {
  mkdirSync(globalSessionsDir, { recursive: true })
  writeFileSync(join(globalSessionsDir, `${sessionId}.jsonl`), '{"type":"user","message":{"role":"user","content":[]}}\n', 'utf-8')
  writeFileSync(join(globalSessionsDir, `${sessionId}-graph.jsonl`), '{"type":"task_created"}\n', 'utf-8')
  writeFileSync(join(globalSessionsDir, `${sessionId}-pi-harness.jsonl`), '{"type":"run"}\n', 'utf-8')
  if (!sdkSessionId) return {}
  mkdirSync(globalPiDir, { recursive: true })
  const transcript = join(globalPiDir, `2026-11-04T00-00-00-000Z_${sdkSessionId}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'session', id: sdkSessionId })}\n`, 'utf-8')
  return { transcript }
}

describe('项目会话布局迁移', () => {
  test('Given 存量 project 会话 When 迁移 Then 文件搬进项目并更新 storageLayout / piSessionFile', async () => {
    const root = makeProject('p1')
    writeWorkspaces([{
      id: 'id-p1', name: 'p1', slug: 'p1', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root,
    }])
    const { transcript } = seedGlobalFiles('sess-1', 'sdk-1')
    writeSessions([{
      id: 'sess-1', title: 'legacy', workspaceId: 'id-p1', agentRuntime: 'pi',
      sdkSessionId: 'sdk-1', piSessionFile: transcript, createdAt: 1, updatedAt: 1,
    }])

    const result = await migrateProjectSessionLayouts()
    expect(result.migratedSessions).toBe(1)
    expect(result.skipped).toEqual([])

    const dataDir = join(root, '.profer', 'sessions', 'sess-1')
    expect(existsSync(join(dataDir, 'messages.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'sess-1-graph.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'sess-1-pi-harness.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'pi', `2026-11-04T00-00-00-000Z_sdk-1.jsonl`))).toBe(true)

    // 中央原文件已移走
    expect(existsSync(join(globalSessionsDir, 'sess-1.jsonl'))).toBe(false)
    expect(existsSync(transcript!)).toBe(false)

    const meta = getAgentSessionMeta('sess-1')
    expect(meta?.storageLayout).toBe('project')
    expect(meta?.piSessionFile).toBe(join(dataDir, 'pi', `2026-11-04T00-00-00-000Z_sdk-1.jsonl`))

    // 迁移标记与项目索引
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(true)
    expect(existsSync(projectSessionIndexPath(root))).toBe(true)
  })

  test('Given 会话正在运行 When 迁移 Then 跳过且不写完成标记，下次可重跑', async () => {
    const root = makeProject('p2')
    writeWorkspaces([{
      id: 'id-p2', name: 'p2', slug: 'p2', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root,
    }])
    seedGlobalFiles('sess-2')
    writeSessions([{ id: 'sess-2', title: 'busy', workspaceId: 'id-p2', createdAt: 1, updatedAt: 1 }])
    setAgentSessionActiveChecker((id) => id === 'sess-2')

    const first = await migrateProjectSessionLayouts()
    expect(first.migratedSessions).toBe(0)
    expect(first.skipped.some((item) => item.includes('busy'))).toBe(true)
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(false)
    expect(existsSync(join(globalSessionsDir, 'sess-2.jsonl'))).toBe(true)

    // 运行结束后重跑成功
    setAgentSessionActiveChecker(undefined)
    const second = await migrateProjectSessionLayouts()
    expect(second.migratedSessions).toBe(1)
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(true)
  })

  test('Given 已完成迁移 When 再次迁移 Then 标记命中，不重复搬运', async () => {
    const root = makeProject('p3')
    writeWorkspaces([{
      id: 'id-p3', name: 'p3', slug: 'p3', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root,
    }])
    seedGlobalFiles('sess-3')
    writeSessions([{ id: 'sess-3', title: 'done', workspaceId: 'id-p3', createdAt: 1, updatedAt: 1 }])

    await migrateProjectSessionLayouts()
    const again = await migrateProjectSessionLayouts()
    expect(again.migratedSessions).toBe(0)
  })

  test('Given 已迁移 When 回滚 Then 文件搬回中央、storageLayout 复位、项目索引删除', async () => {
    const root = makeProject('p4')
    writeWorkspaces([{
      id: 'id-p4', name: 'p4', slug: 'p4', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root,
    }])
    const { transcript } = seedGlobalFiles('sess-4', 'sdk-4')
    writeSessions([{
      id: 'sess-4', title: 'rollback', workspaceId: 'id-p4', agentRuntime: 'pi',
      sdkSessionId: 'sdk-4', piSessionFile: transcript, createdAt: 1, updatedAt: 1,
    }])

    await migrateProjectSessionLayouts()
    const result = await rollbackProjectSessionLayouts()
    expect(result.rolledBack).toBe(1)

    expect(existsSync(join(globalSessionsDir, 'sess-4.jsonl'))).toBe(true)
    expect(existsSync(join(globalPiDir, `2026-11-04T00-00-00-000Z_sdk-4.jsonl`))).toBe(true)
    expect(existsSync(projectSessionIndexPath(root))).toBe(false)
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(false)
    expect(getAgentSessionMeta('sess-4')?.storageLayout).toBe('managed')
  })
})
