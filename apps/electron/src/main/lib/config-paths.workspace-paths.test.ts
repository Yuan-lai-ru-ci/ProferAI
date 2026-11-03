/**
 * config-paths 工作区级路径快照（A1 安全底座）
 *
 * 目的：把「改造前 managed 的返回值」逐字固化下来（I1），并锁住 project 模式的新语义：
 * - configDir = <rootPath>/.profer
 * - 会话 cwd = rootPath（≠ storageDir）
 * - storageDir = <rootPath>/.profer/sessions/<sid>（项目内，随文件夹迁移）；
 *   旧中央目录 `agent-workspaces/<slug>/sessions/<sid>` 仍存在时继续沿用（兼容）
 * - rootPath 不存在时任何函数都不 mkdir（I4）
 *
 * 这里的期望值全部写成硬编码字面量（只跟随临时夹具根），不从被测函数推导。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.PROFER_DEV = '1'

const {
  WorkspaceRootMissingError,
  getAgentSessionCwd,
  getAgentSessionStorageDir,
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath,
  getInactiveSkillsDir,
  getWorkspaceAgentPresetsPath,
  getWorkspaceFilesDir,
  getWorkspaceMcpPath,
  getWorkspaceRootPath,
  getWorkspaceSkillsDir,
  resolveAgentSessionWorkspacePath,
  resolveWorkspaceFilesDir,
} = await import('./config-paths')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const SLUG = 'ws-fixed'
const SESSION_ID = 'sess-fixed'

let root = ''
let configRoot = ''
let indexPath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-config-paths-ws-'))
  configRoot = join(root, 'config')
  indexPath = join(configRoot, 'agent-workspaces.json')
  process.env.PROFER_CONFIG_DIR = configRoot
  invalidateWorkspaceLocation()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PROFER_CONFIG_DIR
})

function writeProjectIndex(projectRoot: string): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({
    version: 4,
    workspaces: [{
      id: 'ws-fixed-id',
      name: '固定夹具',
      slug: SLUG,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'project',
      rootPath: projectRoot,
    }],
  }), 'utf-8')
  invalidateWorkspaceLocation()
}

describe('managed 快照（改造前行为逐字不变）', () => {
  test('Given 固定 slug When 取 10 个工作区路径 Then 与改造前硬编码值一致', () => {
    const workspaceDir = join(configRoot, 'agent-workspaces', SLUG)

    expect(getAgentWorkspacePath(SLUG)).toBe(workspaceDir)
    expect(getWorkspaceRootPath(SLUG)).toBe(workspaceDir)
    expect(getWorkspaceMcpPath(SLUG)).toBe(`${workspaceDir}/mcp.json`)
    expect(getWorkspaceAgentPresetsPath(SLUG)).toBe(`${workspaceDir}/agent-presets.json`)
    expect(getWorkspaceSkillsDir(SLUG)).toBe(`${workspaceDir}/skills`)
    expect(getWorkspaceFilesDir(SLUG)).toBe(`${workspaceDir}/workspace-files`)
    expect(resolveWorkspaceFilesDir(SLUG)).toBe(`${workspaceDir}/workspace-files`)
    expect(getInactiveSkillsDir(SLUG)).toBe(`${workspaceDir}/skills-inactive`)
    expect(getAgentSessionWorkspacePath(SLUG, SESSION_ID)).toBe(`${workspaceDir}/${SESSION_ID}`)
    expect(resolveAgentSessionWorkspacePath(SLUG, SESSION_ID)).toBe(`${workspaceDir}/${SESSION_ID}`)
  })

  test('Given managed When 取会话 cwd 与 storageDir Then 两者相同（改造前的语义合并）', () => {
    const expected = join(configRoot, 'agent-workspaces', SLUG, SESSION_ID)

    expect(getAgentSessionCwd(SLUG, SESSION_ID)).toBe(expected)
    expect(getAgentSessionStorageDir(SLUG, SESSION_ID)).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })
})

describe('project 模式路径', () => {
  test('Given 项目根存在 When 取工作区路径 Then 全部落在 <rootPath>/.profer 下', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)
    const proferDir = join(projectRoot, '.profer')

    expect(getWorkspaceRootPath(SLUG)).toBe(projectRoot)
    expect(getAgentWorkspacePath(SLUG)).toBe(proferDir)
    expect(existsSync(proferDir)).toBe(true)
    expect(getWorkspaceMcpPath(SLUG)).toBe(`${proferDir}/mcp.json`)
    expect(getWorkspaceAgentPresetsPath(SLUG)).toBe(`${proferDir}/agent-presets.json`)
    expect(getWorkspaceSkillsDir(SLUG)).toBe(`${proferDir}/skills`)
    expect(getWorkspaceFilesDir(SLUG)).toBe(`${proferDir}/workspace-files`)
    expect(resolveWorkspaceFilesDir(SLUG)).toBe(`${proferDir}/workspace-files`)
    expect(getInactiveSkillsDir(SLUG)).toBe(`${proferDir}/skills-inactive`)
  })

  test('Given project When 取会话 cwd 与 storageDir Then cwd=rootPath、storageDir 在项目内 .profer/sessions', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)

    const cwd = getAgentSessionCwd(SLUG, SESSION_ID)
    const storageDir = getAgentSessionStorageDir(SLUG, SESSION_ID)

    expect(cwd).toBe(projectRoot)
    expect(storageDir).toBe(`${projectRoot}/.profer/sessions/${SESSION_ID}`)
    expect(storageDir).not.toBe(projectRoot)
    expect(storageDir.startsWith(`${projectRoot}/.profer/sessions`)).toBe(true)
    expect(storageDir.startsWith(configRoot)).toBe(false)
    expect(existsSync(storageDir)).toBe(true)
  })

  test('Given project 旧中央目录存在 When 解析 storageDir Then 继续沿用旧路径（兼容）', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)

    const legacy = join(configRoot, 'agent-workspaces', SLUG, 'sessions', SESSION_ID)
    mkdirSync(legacy, { recursive: true })

    // 项目内还没有该会话，但中央旧目录存在 → 继续用旧路径，旧会话仍可读可续聊。
    expect(resolveAgentSessionWorkspacePath(SLUG, SESSION_ID)).toBe(legacy)
    expect(getAgentSessionStorageDir(SLUG, SESSION_ID)).toBe(legacy)
    expect(existsSync(join(projectRoot, '.profer', 'sessions', SESSION_ID))).toBe(false)
  })

  test('Given project 新会话（项目内与旧中央都不存在）When 解析 storageDir Then 指向项目内', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)

    expect(resolveAgentSessionWorkspacePath(SLUG, SESSION_ID)).toBe(`${projectRoot}/.profer/sessions/${SESSION_ID}`)
  })

  test('Given project 目录不可写 When 取 storageDir Then 自动回退中央 runtimeDir', () => {
    // root 用户不受目录权限限制，跳过（CI 以 root 跑时）。
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const projectDir = join(root, 'readonly-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)
    const proferDir = join(projectRoot, '.profer')
    mkdirSync(proferDir, { recursive: true })
    chmodSync(proferDir, 0o555)
    try {
      const storageDir = getAgentSessionStorageDir(SLUG, SESSION_ID)
      expect(storageDir).toBe(join(configRoot, 'agent-workspaces', SLUG, 'sessions', SESSION_ID))
      expect(existsSync(storageDir)).toBe(true)
    } finally {
      chmodSync(proferDir, 0o755)
    }
  })

  test('Given project When 只读解析 Then 不创建任何目录', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)

    expect(resolveAgentSessionWorkspacePath(SLUG, SESSION_ID)).toBe(`${projectRoot}/.profer/sessions/${SESSION_ID}`)
    expect(resolveWorkspaceFilesDir(SLUG)).toBe(`${projectRoot}/.profer/workspace-files`)
    expect(getWorkspaceRootPath(SLUG)).toBe(projectRoot)

    expect(existsSync(join(projectRoot, '.profer'))).toBe(false)
  })

  test('Given project rootPath 已消失 When 取根/会话路径 Then 抛错且不创建目录（I4）', () => {
    const missingRoot = join(root, 'gone-project')
    writeProjectIndex(missingRoot)

    expect(() => getWorkspaceRootPath(SLUG)).toThrow(WorkspaceRootMissingError)
    expect(() => getAgentWorkspacePath(SLUG)).toThrow(WorkspaceRootMissingError)
    expect(() => getAgentSessionCwd(SLUG, SESSION_ID)).toThrow(WorkspaceRootMissingError)
    expect(() => getAgentSessionStorageDir(SLUG, SESSION_ID)).toThrow(WorkspaceRootMissingError)

    expect(existsSync(missingRoot)).toBe(false)
    expect(existsSync(join(missingRoot, '.profer'))).toBe(false)
  })
})
