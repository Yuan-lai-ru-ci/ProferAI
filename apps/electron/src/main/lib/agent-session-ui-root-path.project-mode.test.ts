/**
 * P1-2：会话在 UI 侧（`@` 文件引用 / 侧栏文件面板 / 预览相对路径基准）的根目录。
 *
 * - managed：与会话目录相同（改造前行为）
 * - project：必须是项目根 rootPath；会话私有数据在中央 storageDir，用户不该看到
 *
 * `GET_SESSION_PATH`（ipc.ts）与 `getFileSearchRoots` 都以此函数为准：
 * 修复前 project 拿到的是 storageDir，`@` 引用与文件面板里看不到任何项目文件。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-ui-root-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { resolveAgentSessionUiRootPath, resolveAgentSessionCwd, resolveAgentSessionStoragePath } = await import('./agent-session-manager')
const { getAgentSessionWorkspacePath, resolveAgentSessionWorkspacePath } = await import('./config-paths')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const INDEX_PATH = join(configRoot, 'agent-workspaces.json')
const PROJECT_SLUG = 'ws-ui-project'
const MANAGED_SLUG = 'ws-ui-managed'
const PROJECT_ID = 'ws-ui-project-id'
const MANAGED_ID = 'ws-ui-managed-id'
const SESSION_ID = 'session-ui-root'

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(configRoot, { recursive: true, force: true })
  mkdirSync(configRoot, { recursive: true })
})

function writeIndex(workspaces: Array<Record<string, unknown>>): void {
  writeFileSync(INDEX_PATH, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function writeManagedIndex(): void {
  writeIndex([
    { id: MANAGED_ID, name: 'managed', slug: MANAGED_SLUG, createdAt: 1, updatedAt: 1, type: 'personal' },
  ])
}

function writeProjectIndex(): string {
  const projectDir = join(sandbox, 'ui-project')
  mkdirSync(projectDir, { recursive: true })
  const rootPath = realpathSync(projectDir)
  writeIndex([
    {
      id: PROJECT_ID,
      name: 'project',
      slug: PROJECT_SLUG,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'project',
      rootPath,
    },
  ])
  return rootPath
}

describe('resolveAgentSessionUiRootPath', () => {
  test('Given project When 解析 UI 根 Then 是项目根，既不是 storageDir 也不是 中央目录', () => {
    const rootPath = writeProjectIndex()
    const storageDir = getAgentSessionWorkspacePath(PROJECT_SLUG, SESSION_ID)

    const uiRoot = resolveAgentSessionUiRootPath(PROJECT_ID, SESSION_ID)

    expect(uiRoot).toBe(rootPath)
    expect(uiRoot).not.toBe(storageDir)
    expect(storageDir.startsWith(rootPath)).toBe(false)
    // 与会话 cwd 一致（project 下 cwd 就是项目根）
    expect(resolveAgentSessionCwd(PROJECT_SLUG, SESSION_ID)).toBe(uiRoot!)
  })

  test('Given managed When 解析 UI 根 Then 等于会话目录（与改造前逐字一致）', () => {
    writeManagedIndex()
    const storageDir = getAgentSessionWorkspacePath(MANAGED_SLUG, SESSION_ID)

    expect(resolveAgentSessionUiRootPath(MANAGED_ID, SESSION_ID)).toBe(storageDir)
  })

  test('Given 工作区已被移除 When 解析 UI 根 Then 返回 undefined（IPC 映射为 null）', () => {
    writeManagedIndex()
    expect(resolveAgentSessionUiRootPath('ws-unknown-id', SESSION_ID)).toBeUndefined()
  })

  test('Given project 根已不可用 When 解析 UI 根 Then 用索引里的 rootPath 兜底，不抛错也不指到中央目录', () => {
    const missingRoot = join(sandbox, 'moved-project')
    writeIndex([
      {
        id: PROJECT_ID,
        name: 'project',
        slug: PROJECT_SLUG,
        createdAt: 1,
        updatedAt: 1,
        type: 'personal',
        storageMode: 'project',
        rootPath: missingRoot,
      },
    ])

    // UI 侧不因项目失效而报错（renderer 只拿不到文件列表），但绝不能指向中央存储目录
    expect(resolveAgentSessionUiRootPath(PROJECT_ID, SESSION_ID)).toBe(missingRoot)
    expect(resolveAgentSessionUiRootPath(PROJECT_ID, SESSION_ID)).not.toBe(
      resolveAgentSessionWorkspacePath(PROJECT_SLUG, SESSION_ID),
    )
  })
})

/**
 * 文件改动 chip 的草稿区基准：project 下必须是 storageDir（不是 UI 根）。
 *
 * 用 UI 根（项目根）当草稿区会把项目内改动全部隐藏，chip 变空。
 */
describe('resolveAgentSessionStoragePath（草稿区基准）', () => {
  test('Given project When 解析草稿区 Then 是中央 sessions/<sid>，与 UI 根互不相交且不建目录', () => {
    const rootPath = writeProjectIndex()

    const storagePath = resolveAgentSessionStoragePath(PROJECT_ID, SESSION_ID)

    expect(storagePath).toBe(resolveAgentSessionWorkspacePath(PROJECT_SLUG, SESSION_ID))
    expect(storagePath).not.toBe(rootPath)
    expect(rootPath.startsWith(storagePath!)).toBe(false)
    // 纯查询：只读解析不得因为「问一下路径」就创建会话目录
    expect(existsSync(storagePath!)).toBe(false)
  })

  test('Given project 根已不可用 When 解析草稿区 Then 仍返回中央目录，不抛错', () => {
    const missingRoot = join(sandbox, 'moved-project')
    writeIndex([
      {
        id: PROJECT_ID,
        name: 'project',
        slug: PROJECT_SLUG,
        createdAt: 1,
        updatedAt: 1,
        type: 'personal',
        storageMode: 'project',
        rootPath: missingRoot,
      },
    ])

    expect(() => resolveAgentSessionStoragePath(PROJECT_ID, SESSION_ID)).not.toThrow()
    expect(resolveAgentSessionStoragePath(PROJECT_ID, SESSION_ID))
      .toBe(resolveAgentSessionWorkspacePath(PROJECT_SLUG, SESSION_ID))
  })

  test('Given managed When 解析草稿区 Then 等于会话目录（与 UI 根相同，行为不变）', () => {
    writeManagedIndex()

    const storagePath = resolveAgentSessionStoragePath(MANAGED_ID, SESSION_ID)

    expect(storagePath).toBe(resolveAgentSessionWorkspacePath(MANAGED_SLUG, SESSION_ID))
    expect(storagePath).toBe(resolveAgentSessionUiRootPath(MANAGED_ID, SESSION_ID)!)
  })

  test('Given 工作区已被移除 When 解析草稿区 Then 返回 undefined', () => {
    writeManagedIndex()
    expect(resolveAgentSessionStoragePath('ws-unknown-id', SESSION_ID)).toBeUndefined()
  })
})

/**
 * 结构性检查：ipc.ts 的两个消费者必须走同一份 UI 根语义。
 *
 * ipc.ts 直接依赖 electron（ipcMain / BrowserWindow），无法在本进程内 import 验证，
 * 这里钉住接线点：GET_SESSION_PATH 不再自行拼 storageDir，getFileSearchRoots 在 project
 * 下把 rootPath 放在最前面（`@` 引用 / 文件面板根）。
 */
describe('ipc.ts 接线', () => {
  const ipcSource = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')

  test('GET_SESSION_PATH 走 resolveAgentSessionUiRootPath，不再返回 storageDir', () => {
    const start = ipcSource.indexOf('AGENT_IPC_CHANNELS.GET_SESSION_PATH,')
    expect(start).toBeGreaterThan(-1)
    const handler = ipcSource.slice(start, ipcSource.indexOf('})', start))
    expect(handler).toContain('resolveAgentSessionUiRootPath(workspaceId, sessionId)')
    expect(handler).not.toContain('getAgentSessionWorkspacePath')
  })

  test('getFileSearchRoots 在 project 下先加 rootPath，再加 storageDir', () => {
    const start = ipcSource.indexOf('function getFileSearchRoots(')
    expect(start).toBeGreaterThan(-1)
    const fn = ipcSource.slice(start, ipcSource.indexOf('\n}', start))
    expect(fn).toContain("location.mode === 'project'")
    expect(fn).toContain('addRoot(location.rootPath)')
    expect(fn.indexOf('addRoot(location.rootPath)')).toBeLessThan(
      fn.indexOf('addRoot(getAgentSessionWorkspacePath(workspace.slug, sessionId))'),
    )
  })

  test('GET_SESSION_STORAGE_PATH 走 resolveAgentSessionStoragePath，不混用 UI 根', () => {
    const start = ipcSource.indexOf('AGENT_IPC_CHANNELS.GET_SESSION_STORAGE_PATH,')
    expect(start).toBeGreaterThan(-1)
    const handler = ipcSource.slice(start, ipcSource.indexOf('})', start))
    expect(handler).toContain('resolveAgentSessionStoragePath(workspaceId, sessionId)')
    expect(handler).not.toContain('resolveAgentSessionUiRootPath')
  })

  test('preload 暴露 getAgentSessionStoragePath 并走 GET_SESSION_STORAGE_PATH', () => {
    const preloadSource = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')
    // 类型声明与实现同名，取最后一处（实现体）验证接线。
    const start = preloadSource.lastIndexOf('getAgentSessionStoragePath')
    expect(start).toBeGreaterThan(-1)
    const impl = preloadSource.slice(start, preloadSource.indexOf('},', start))
    expect(impl).toContain('AGENT_IPC_CHANNELS.GET_SESSION_STORAGE_PATH')
  })
})
