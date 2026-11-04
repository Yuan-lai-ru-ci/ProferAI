/**
 * 回归：project 会话 fork 后，任务图必须落在 fork 会话自己的项目数据目录。
 *
 * 旧实现 `copyTruncatedGraphJsonl` 写死 `getAgentSessionsDir()`，project 会话 fork 后
 * 图被写到中央目录：新会话读不到（任务图空白），中央还多出一份影子文件。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-fork-graph-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const FORK_SDK_ID = 'fork-sdk-session'

// SDK fork 只负责产出 JSONL；本测试验证 Profer 侧的图复制落点。
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: async () => {
    const dir = join(configRoot, 'sdk-config', 'projects', 'mock-hash')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${FORK_SDK_ID}.jsonl`), '', 'utf-8')
    return { sessionId: FORK_SDK_ID }
  },
}))

const {
  createAgentSession,
  forkAgentSession,
  updateAgentSessionMeta,
} = await import('./agent-session-manager')
const { appendGraphEvent, loadGraph } = await import('./project-graph-service')
const { getAgentSessionGraphPath } = await import('./config-paths')
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

describe('project 会话 fork 的任务图落点', () => {
  test('Given project 会话 When fork Then 图写到 fork 会话的项目数据目录，不写中央目录', async () => {
    const root = makeProject('fork-project')
    writeWorkspaces([{
      id: 'id-p1', name: 'p1', slug: 'p1', createdAt: 1, updatedAt: 1,
      type: 'personal', storageMode: 'project', rootPath: root,
    }])

    const source = createAgentSession('source', undefined, 'id-p1', undefined, 'claude')
    updateAgentSessionMeta(source.id, { sdkSessionId: 'sdk-source' })
    appendGraphEvent(source.id, {
      type: 'task_created',
      taskId: 'task-1',
      timestamp: 1,
      payload: { subject: 'fork me', description: '', dependsOn: [] },
    })

    const forked = await forkAgentSession({ sessionId: source.id })

    const destGraphPath = getAgentSessionGraphPath(forked.id)
    expect(destGraphPath).toBe(join(root, '.profer', 'sessions', forked.id, `${forked.id}-graph.jsonl`))
    expect(existsSync(destGraphPath)).toBe(true)
    expect(loadGraph(forked.id).nodes['task-1']?.subject).toBe('fork me')

    // 中央目录不能出现 fork 会话的影子图文件
    expect(existsSync(join(configRoot, 'agent-sessions', `${forked.id}-graph.jsonl`))).toBe(false)
  })
})
