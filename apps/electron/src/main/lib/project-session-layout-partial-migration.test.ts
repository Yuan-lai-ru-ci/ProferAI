/**
 * 修复项 4：消息、任务图、Harness 独立迁移。
 *
 * 旧实现把三个组件包在「目标 messages.jsonl 不存在」的条件里：目标已有消息时
 * graph/Harness 被静默跳过，会话却可能被标记为 project 布局。
 *
 * 锁住：
 * - 三个组件各自检查、各自搬迁，目标已有消息不影响 graph/Harness；
 * - 同一组件源和目标同时存在时不覆盖任何一边，整条会话不标记完成并上报冲突；
 * - 冲突时不做半搬，布局字段与实际可读取位置保持一致；
 * - 解决冲突后重跑可安全继续。
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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-layout-partial-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  getAgentSessionMeta,
  migrateProjectSessionLayouts,
  setAgentSessionActiveChecker,
} = await import('./agent-session-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')
const globalSessionsDir = join(configRoot, 'agent-sessions')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [indexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  rmSync(globalSessionsDir, { recursive: true, force: true })
  rmSync(join(configRoot, 'sdk-config'), { recursive: true, force: true })
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

function seedGlobal(sessionId: string, files: { messages?: string; graph?: string; harness?: string }): void {
  mkdirSync(globalSessionsDir, { recursive: true })
  if (files.messages) writeFileSync(join(globalSessionsDir, `${sessionId}.jsonl`), files.messages, 'utf-8')
  if (files.graph) writeFileSync(join(globalSessionsDir, `${sessionId}-graph.jsonl`), files.graph, 'utf-8')
  if (files.harness) writeFileSync(join(globalSessionsDir, `${sessionId}-pi-harness.jsonl`), files.harness, 'utf-8')
}

function seedProjectSession(
  root: string,
  sessionId: string,
  files: { messages?: string; graph?: string; harness?: string },
): string {
  const dataDir = join(root, '.profer', 'sessions', sessionId)
  mkdirSync(dataDir, { recursive: true })
  if (files.messages) writeFileSync(join(dataDir, 'messages.jsonl'), files.messages, 'utf-8')
  if (files.graph) writeFileSync(join(dataDir, `${sessionId}-graph.jsonl`), files.graph, 'utf-8')
  if (files.harness) writeFileSync(join(dataDir, `${sessionId}-pi-harness.jsonl`), files.harness, 'utf-8')
  // 半迁移状态：sidecar 已存在但仍是中央布局，且比全局索引旧，不触发对账合并。
  writeFileSync(join(dataDir, 'session.json'), JSON.stringify({
    id: sessionId, title: '半迁移会话', workspaceId: 'stale', storageLayout: 'managed', createdAt: 1, updatedAt: 1,
  }), 'utf-8')
  return dataDir
}

function seedWorkspace(root: string, slug: string): void {
  writeWorkspaces([{
    id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root,
  }])
}

function seedSession(sessionId: string, workspaceSlug: string): void {
  writeSessions([{
    id: sessionId, title: '半迁移会话', workspaceId: `id-${workspaceSlug}`, createdAt: 1, updatedAt: 100,
  }])
}

describe('项目会话布局部分迁移', () => {
  test('Given 目标已有 messages、源端仍有 graph/Harness When 迁移 Then graph/Harness 独立搬入', async () => {
    const root = makeProject('partial-a')
    seedWorkspace(root, 'partial-a')
    seedSession('sess-a', 'partial-a')
    seedGlobal('sess-a', { graph: '{"type":"task_created"}\n', harness: '{"type":"run"}\n' })
    const dataDir = seedProjectSession(root, 'sess-a', { messages: '{"type":"project-messages"}\n' })

    const result = await migrateProjectSessionLayouts()

    expect(result.conflicts).toEqual([])
    expect(result.migratedSessions).toBe(1)
    expect(readFileSync(join(dataDir, 'messages.jsonl'), 'utf-8')).toBe('{"type":"project-messages"}\n')
    expect(existsSync(join(dataDir, 'sess-a-graph.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'sess-a-pi-harness.jsonl'))).toBe(true)
    expect(existsSync(join(globalSessionsDir, 'sess-a-graph.jsonl'))).toBe(false)
    expect(existsSync(join(globalSessionsDir, 'sess-a-pi-harness.jsonl'))).toBe(false)

    expect(getAgentSessionMeta('sess-a')?.storageLayout).toBe('project')
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(true)
  })

  test('Given 消息源和目标同时存在 When 迁移 Then 不覆盖任何一边、不标记完成，解决后可重跑', async () => {
    const root = makeProject('partial-b')
    seedWorkspace(root, 'partial-b')
    seedSession('sess-b', 'partial-b')
    seedGlobal('sess-b', {
      messages: '{"type":"global-messages"}\n',
      graph: '{"type":"global-graph"}\n',
      harness: '{"type":"global-harness"}\n',
    })
    const dataDir = seedProjectSession(root, 'sess-b', {
      messages: '{"type":"project-messages"}\n',
      graph: '{"type":"project-graph"}\n',
    })

    const result = await migrateProjectSessionLayouts()

    expect(result.migratedSessions).toBe(0)
    expect(result.conflicts.map((conflict) => conflict.component).sort()).toEqual(['graph', 'messages'])
    expect(result.skipped.some((item) => item.includes('布局冲突'))).toBe(true)

    // 两边文件都保留，内容不被覆盖
    expect(readFileSync(join(globalSessionsDir, 'sess-b.jsonl'), 'utf-8')).toBe('{"type":"global-messages"}\n')
    expect(readFileSync(join(dataDir, 'messages.jsonl'), 'utf-8')).toBe('{"type":"project-messages"}\n')
    expect(readFileSync(join(globalSessionsDir, 'sess-b-graph.jsonl'), 'utf-8')).toBe('{"type":"global-graph"}\n')
    expect(readFileSync(join(dataDir, 'sess-b-graph.jsonl'), 'utf-8')).toBe('{"type":"project-graph"}\n')
    // 冲突时不半搬：Harness 仍在中央
    expect(existsSync(join(globalSessionsDir, 'sess-b-pi-harness.jsonl'))).toBe(true)
    // 布局字段与实际可读位置一致：仍是中央布局，且不写完成标记
    expect(getAgentSessionMeta('sess-b')?.storageLayout).not.toBe('project')
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(false)

    // 人工解决冲突后重跑：已搬过的组件不重复搬运，剩余组件继续
    rmSync(join(dataDir, 'messages.jsonl'))
    rmSync(join(dataDir, 'sess-b-graph.jsonl'))
    const retry = await migrateProjectSessionLayouts()
    expect(retry.conflicts).toEqual([])
    expect(retry.migratedSessions).toBe(1)
    expect(readFileSync(join(dataDir, 'messages.jsonl'), 'utf-8')).toBe('{"type":"global-messages"}\n')
    expect(existsSync(join(dataDir, 'sess-b-graph.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'sess-b-pi-harness.jsonl'))).toBe(true)
    expect(getAgentSessionMeta('sess-b')?.storageLayout).toBe('project')
    expect(existsSync(join(root, '.profer', 'sessions', '.layout-v2.json'))).toBe(true)
  })

  test('Given 只有 graph 冲突 When 迁移 Then 消息不被半搬，解决后一次完成', async () => {
    const root = makeProject('partial-c')
    seedWorkspace(root, 'partial-c')
    seedSession('sess-c', 'partial-c')
    seedGlobal('sess-c', { messages: '{"type":"global-messages"}\n', graph: '{"type":"global-graph"}\n' })
    const dataDir = seedProjectSession(root, 'sess-c', { graph: '{"type":"project-graph"}\n' })

    const result = await migrateProjectSessionLayouts()

    expect(result.migratedSessions).toBe(0)
    expect(result.conflicts).toEqual([{
      sessionId: 'sess-c',
      title: '半迁移会话',
      component: 'graph',
      sourcePath: join(globalSessionsDir, 'sess-c-graph.jsonl'),
      targetPath: join(dataDir, 'sess-c-graph.jsonl'),
    }])
    // 预检阻止了半搬：消息仍在中央
    expect(existsSync(join(globalSessionsDir, 'sess-c.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'messages.jsonl'))).toBe(false)
    expect(getAgentSessionMeta('sess-c')?.storageLayout).not.toBe('project')

    rmSync(join(dataDir, 'sess-c-graph.jsonl'))
    const retry = await migrateProjectSessionLayouts()
    expect(retry.migratedSessions).toBe(1)
    expect(existsSync(join(dataDir, 'messages.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'sess-c-graph.jsonl'))).toBe(true)
    expect(getAgentSessionMeta('sess-c')?.storageLayout).toBe('project')
  })
})
