/**
 * P1-1 回归：project 工作区的「回退到此处 / 清空对话」必须把文件快照恢复到项目根，
 * 不能写到中央会话存储目录（storageDir）。
 *
 * 背景：`rewindFilesFromSnapshot` 的 `cwd` 是快照相对路径的基准 + 允许写入根。
 * project 下 cwd = rootPath，storageDir = `~/.profer/agent-workspaces/<slug>/sessions/<sid>`。
 * 两者混用会让「回退」在中央目录里写出一棵影子目录，而用户项目文件没有变化（还报成功）。
 *
 * managed 侧同时保留一条对照用例：cwd === storageDir，行为与改造前逐字一致。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-rewind-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const INDEX_PATH = join(configRoot, 'agent-workspaces.json')
const PROJECT_SLUG = 'ws-project'
const MANAGED_SLUG = 'ws-managed'
const PROJECT_WORKSPACE_ID = 'ws-project-id'
const MANAGED_WORKSPACE_ID = 'ws-managed-id'
const SDK_SESSION_ID = 'sdk-project-rewind'

type Orchestrator = {
  rewindSession: (
    sessionId: string,
    assistantMessageUuid?: string,
  ) => Promise<{ remainingMessages: number; fileRewind?: { canRewind: boolean; error?: string; filesChanged?: string[] } }>
}

// 每个用例用带 cache key 的独立模块实例：agent-service 在模块初始化时就 new 了
// AgentOrchestrator，两个模块的静态循环依赖会撑到「Cannot access before initialization」。
let orchestrator: Orchestrator
let sessions: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')

let projectRoot = ''

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(async () => {
  rmSync(configRoot, { recursive: true, force: true })
  mkdirSync(configRoot, { recursive: true })
  projectRoot = realpathSync(mkdtempSync(join(sandbox, 'proj-')))
  writeIndex([
    {
      id: PROJECT_WORKSPACE_ID,
      name: 'project',
      slug: PROJECT_SLUG,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'project',
      rootPath: projectRoot,
    },
    { id: MANAGED_WORKSPACE_ID, name: 'managed', slug: MANAGED_SLUG, createdAt: 1, updatedAt: 1, type: 'personal' },
  ])

  const cacheKey = `${Date.now()}-${Math.random()}`
  const { AgentOrchestrator } = await import(`./agent-orchestrator?project-rewind=${cacheKey}`)
  sessions = await import(`./agent-session-manager?project-rewind=${cacheKey}`)
  configPaths = await import(`./config-paths?project-rewind=${cacheKey}`)
  orchestrator = new AgentOrchestrator({} as never, { on: () => {}, emit: () => {} } as never) as never
})

function writeIndex(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(INDEX_PATH, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function seedProferMessages(sessionId: string, lines: unknown[]): void {
  const dir = configPaths.getAgentSessionsDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

const userMsg = (uuid: string, text: string) => ({ type: 'user', uuid, message: { content: [{ type: 'text', text }] } })
const assistantMsg = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: '回复' }] } })

/**
 * 写一份 SDK session JSONL + file-history 备份。
 *
 * 快照语义：`messageId` = 该 user 消息发出时的文件状态。
 * - `u-1` 快照：会话起点（原始内容）
 * - `u-2` 快照：第一轮 assistant 完成后的状态（回退到 a-1 的目标状态）
 */
function seedSdkSession(): void {
  const projectsDir = join(configPaths.getSdkConfigDir(), 'projects', 'fixture-project')
  mkdirSync(projectsDir, { recursive: true })
  const lines = [
    userMsg('u-1', '第一问'),
    assistantMsg('a-1'),
    {
      type: 'file-history-snapshot',
      isSnapshotUpdate: false,
      snapshot: { messageId: 'u-2', trackedFileBackups: { 'src/app.ts': { backupFileName: 'bak-after-first' } } },
    },
    userMsg('u-2', '第二问'),
    assistantMsg('a-2'),
    {
      type: 'file-history-snapshot',
      isSnapshotUpdate: false,
      snapshot: { messageId: 'u-1', trackedFileBackups: { 'src/app.ts': { backupFileName: 'bak-original' } } },
    },
  ]
  writeFileSync(join(projectsDir, `${SDK_SESSION_ID}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')

  const backupsDir = join(configPaths.getSdkConfigDir(), 'file-history', SDK_SESSION_ID)
  mkdirSync(backupsDir, { recursive: true })
  writeFileSync(join(backupsDir, 'bak-after-first'), 'ORIGINAL AT TURN 1', 'utf-8')
  writeFileSync(join(backupsDir, 'bak-original'), 'ORIGINAL AT SESSION START', 'utf-8')
}

function createSessionWithSdk(workspaceId: string): string {
  const meta = sessions.createAgentSession('rewind', undefined, workspaceId, undefined, 'claude')
  sessions.updateAgentSessionMeta(meta.id, { sdkSessionId: SDK_SESSION_ID })
  seedProferMessages(meta.id, [userMsg('u-1', '第一问'), assistantMsg('a-1'), userMsg('u-2', '第二问'), assistantMsg('a-2')])
  seedSdkSession()
  return meta.id
}

function writeProjectFile(relativePath: string, content: string): string {
  const fullPath = join(projectRoot, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

describe('project：回退到此处 / 清空对话把文件恢复到项目根', () => {
  test('Given 项目会话 When 回退到此处 Then 项目文件被恢复、中央会话目录里不出现影子文件', async () => {
    const sessionId = createSessionWithSdk(PROJECT_WORKSPACE_ID)
    const projectFile = writeProjectFile('src/app.ts', 'NEW CONTENT AFTER EDIT')
    const storageDir = configPaths.getAgentSessionWorkspacePath(PROJECT_SLUG, sessionId)

    const result = await orchestrator.rewindSession(sessionId, 'a-1')

    expect(result.fileRewind?.canRewind).toBe(true)
    expect(readFileSync(projectFile, 'utf-8')).toBe('ORIGINAL AT TURN 1')
    // 关键回归断言：cwd 不是 storageDir，中央目录不能出现影子文件
    expect(existsSync(join(storageDir, 'src', 'app.ts'))).toBe(false)
  })

  test('Given 项目会话 When 清空对话 Then 项目文件恢复到会话起点，存储目录仍干净', async () => {
    const sessionId = createSessionWithSdk(PROJECT_WORKSPACE_ID)
    const projectFile = writeProjectFile('src/app.ts', 'EDITED IN SESSION')
    const storageDir = configPaths.getAgentSessionWorkspacePath(PROJECT_SLUG, sessionId)

    const result = await orchestrator.rewindSession(sessionId)

    expect(result.remainingMessages).toBe(0)
    expect(result.fileRewind?.canRewind).toBe(true)
    expect(readFileSync(projectFile, 'utf-8')).toBe('ORIGINAL AT SESSION START')
    expect(existsSync(join(storageDir, 'src', 'app.ts'))).toBe(false)
  })

  test('Given 项目根已不可用 When 回退 Then 直接报错，不静默改到用户主目录', async () => {
    const sessionId = createSessionWithSdk(PROJECT_WORKSPACE_ID)
    writeIndex([
      {
        id: PROJECT_WORKSPACE_ID,
        name: 'project',
        slug: PROJECT_SLUG,
        createdAt: 1,
        updatedAt: 1,
        type: 'personal',
        storageMode: 'project',
        rootPath: join(sandbox, 'missing-project'),
      },
    ])

    // 项目目录不存在时存储目录解析会抛 WorkspaceRootMissingError（与改造前一致），
    // 断言重点是「报错而不是回落到 homedir 执行文件恢复」。
    await expect(orchestrator.rewindSession(sessionId, 'a-1')).rejects.toThrow('项目目录不存在')
  })
})

describe('工作区已被移除的会话：不把用户主目录当 cwd', () => {
  test('Given 会话还挂着已移除的 workspaceId When 回退 Then 对话仍截断，文件恢复明确降级', async () => {
    const sessionId = createSessionWithSdk('ws-removed-project')
    // 索引里删掉这个工作区（project 移除 = 只删索引，会话保留）
    writeIndex([
      { id: MANAGED_WORKSPACE_ID, name: 'managed', slug: MANAGED_SLUG, createdAt: 1, updatedAt: 1, type: 'personal' },
    ])

    const result = await orchestrator.rewindSession(sessionId, 'a-1')

    expect(result.remainingMessages).toBe(2)
    expect(result.fileRewind?.canRewind).toBe(false)
    expect(result.fileRewind?.error).toBe('项目目录不可用，文件未回退')
  })
})

describe('managed：cwd 仍等于会话存储目录（零回归）', () => {
  test('Given managed 会话 When 回退到此处 Then 文件恢复到会话目录（旧行为）', async () => {
    const sessionId = createSessionWithSdk(MANAGED_WORKSPACE_ID)
    const storageDir = configPaths.getAgentSessionWorkspacePath(MANAGED_SLUG, sessionId)
    mkdirSync(join(storageDir, 'src'), { recursive: true })
    writeFileSync(join(storageDir, 'src', 'app.ts'), 'EDITED', 'utf-8')

    const result = await orchestrator.rewindSession(sessionId, 'a-1')

    expect(result.fileRewind?.canRewind).toBe(true)
    expect(readFileSync(join(storageDir, 'src', 'app.ts'), 'utf-8')).toBe('ORIGINAL AT TURN 1')
    expect(existsSync(join(projectRoot, 'src', 'app.ts'))).toBe(false)
  })
})
