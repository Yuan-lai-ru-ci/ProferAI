/**
 * config-paths 工作区级路径快照（A1 安全底座）
 *
 * 目的：把「改造前 managed 的返回值」逐字固化下来（I1），并锁住 project 模式的新语义：
 * - configDir = <rootPath>/.profer
 * - 会话 cwd = rootPath（≠ storageDir）
 * - storageDir = <configRoot>/agent-workspaces/<slug>/sessions/<sid>，永不进入项目（I3）
 * - rootPath 不存在时任何函数都不 mkdir（I4）
 *
 * 这里的期望值全部写成硬编码字面量（只跟随临时夹具根），不从被测函数推导。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

  test('Given project When 取会话 cwd 与 storageDir Then cwd=rootPath 且 storageDir 不含项目源码（I2）', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)

    const cwd = getAgentSessionCwd(SLUG, SESSION_ID)
    const storageDir = getAgentSessionStorageDir(SLUG, SESSION_ID)

    expect(cwd).toBe(projectRoot)
    expect(storageDir).toBe(`${configRoot}/agent-workspaces/${SLUG}/sessions/${SESSION_ID}`)
    expect(storageDir).not.toBe(projectRoot)
    expect(storageDir.startsWith(projectRoot)).toBe(false)
    expect(storageDir.startsWith(configRoot)).toBe(true)
    expect(existsSync(storageDir)).toBe(true)
  })

  test('Given project When 只读解析 Then 不创建任何目录', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    const projectRoot = realpathSync(projectDir)
    writeProjectIndex(projectDir)

    expect(resolveAgentSessionWorkspacePath(SLUG, SESSION_ID)).toBe(`${configRoot}/agent-workspaces/${SLUG}/sessions/${SESSION_ID}`)
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
