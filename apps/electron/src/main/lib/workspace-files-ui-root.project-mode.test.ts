/**
 * 「工作区文件」面板的展示根。
 *
 * - managed：`<workspace>/workspace-files`（工作区根含 sessions 等内部目录，不能整体暴露）
 * - project：项目根（project 模式下「工作区」就是绑定的项目文件夹）
 *
 * 修复前 project 也返回 `<root>/.profer/workspace-files`，用户在面板里看不到任何项目文件。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-workspace-files-ui-root-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { resolveWorkspaceFilesUiRootPath } = await import('./config-paths')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const INDEX_PATH = join(configRoot, 'agent-workspaces.json')
const PROJECT_SLUG = 'ws-files-project'
const MANAGED_SLUG = 'ws-files-managed'

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

function writeProjectIndex(rootPath: string): void {
  writeIndex([
    {
      id: 'ws-files-project-id',
      name: 'project',
      slug: PROJECT_SLUG,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'project',
      rootPath,
    },
  ])
}

describe('resolveWorkspaceFilesUiRootPath', () => {
  test('Given project When 解析工作区文件根 Then 是项目根', () => {
    const projectDir = join(sandbox, 'project')
    mkdirSync(projectDir, { recursive: true })
    const rootPath = realpathSync(projectDir)
    writeProjectIndex(rootPath)

    expect(resolveWorkspaceFilesUiRootPath(PROJECT_SLUG)).toBe(rootPath)
  })

  test('Given project When 解析工作区文件根 Then 不在项目里创建 .profer/workspace-files', () => {
    const projectDir = join(sandbox, 'project-no-mkdir')
    mkdirSync(projectDir, { recursive: true })
    const rootPath = realpathSync(projectDir)
    writeProjectIndex(rootPath)

    resolveWorkspaceFilesUiRootPath(PROJECT_SLUG)

    expect(existsSync(join(rootPath, '.profer', 'workspace-files'))).toBe(false)
  })

  test('Given managed When 解析工作区文件根 Then 是 workspace-files 子目录（与改造前一致）', () => {
    writeIndex([
      { id: 'ws-files-managed-id', name: 'managed', slug: MANAGED_SLUG, createdAt: 1, updatedAt: 1, type: 'personal' },
    ])

    const root = resolveWorkspaceFilesUiRootPath(MANAGED_SLUG)

    expect(root.endsWith(join(MANAGED_SLUG, 'workspace-files'))).toBe(true)
    expect(existsSync(root)).toBe(true)
  })

  test('Given project 但 rootPath 缺失（降级）When 解析 Then 回落到 workspace-files，不猜项目路径', () => {
    writeIndex([
      {
        id: 'ws-files-project-id',
        name: 'project',
        slug: PROJECT_SLUG,
        createdAt: 1,
        updatedAt: 1,
        type: 'personal',
        storageMode: 'project',
      },
    ])

    const root = resolveWorkspaceFilesUiRootPath(PROJECT_SLUG)

    expect(root.endsWith(join(PROJECT_SLUG, 'workspace-files'))).toBe(true)
  })

  test('Given project 的 rootPath 绝对但目录已被移走 When 解析 Then 仍返回该路径（不猜、不建目录）', () => {
    const missingRoot = join(sandbox, 'moved-project')
    writeProjectIndex(missingRoot)

    const root = resolveWorkspaceFilesUiRootPath(PROJECT_SLUG)

    expect(root).toBe(missingRoot)
    expect(existsSync(missingRoot)).toBe(false)
  })
})
