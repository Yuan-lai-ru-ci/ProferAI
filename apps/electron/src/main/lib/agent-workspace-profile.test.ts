import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const {
  createAgentWorkspace,
  ensurePluginManifest,
  getWorkspaceMemorySummary,
  getWorkspaceProfilePath,
  getWorkspaceAutoMemoryDir,
  readWorkspaceProfile,
  writeWorkspaceProfile,
} = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = () => join(configRoot, 'agent-workspaces.json')

/** 写入一个 project 工作区索引条目（project 模式的唯一来源）。 */
function writeProjectWorkspace(rootPath: string, slug = 'project-ws'): void {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(indexPath(), JSON.stringify({
    version: 4,
    workspaces: [{
      id: `id-${slug}`,
      name: '项目工作区',
      slug,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'project',
      rootPath,
    }],
  }), 'utf-8')
  invalidateWorkspaceLocation()
}

let configRoot = ''
const projectRoots: string[] = []
const previousConfigRoot = process.env.PROFER_CONFIG_DIR

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'profer-workspace-profile-'))
  process.env.PROFER_CONFIG_DIR = configRoot
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(configRoot, { recursive: true, force: true })
  while (projectRoots.length > 0) rmSync(projectRoots.pop()!, { recursive: true, force: true })
})

function makeProjectRoot(): string {
  // locator 会对 rootPath 做 realpath 归一化（macOS 上 /var → /private/var），
  // 测试夹具必须先归一化，否则断言比的是两个不同字符串。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-project-root-')))
  projectRoots.push(root)
  return root
}

describe('Profer workspace profile', () => {
  test('旧工作区 CLAUDE.md 仅兼容读取，新写入不会回写旧文件', () => {
    const workspace = createAgentWorkspace('Profile Compatibility')
    const workspaceRoot = join(configRoot, 'agent-workspaces', workspace.slug)
    const legacyPath = join(workspaceRoot, 'CLAUDE.md')
    const profilePath = getWorkspaceProfilePath(workspace.slug)
    writeFileSync(legacyPath, '# legacy workspace profile\n', 'utf-8')

    expect(readWorkspaceProfile(workspace.slug).content).toBe('# legacy workspace profile\n')
    expect(getWorkspaceMemorySummary(workspace.slug).workspaceProfile.path).toBe(legacyPath)

    writeWorkspaceProfile(workspace.slug, '# new workspace profile\n')

    expect(existsSync(profilePath)).toBe(true)
    expect(readFileSync(legacyPath, 'utf-8')).toBe('# legacy workspace profile\n')
    expect(readFileSync(profilePath, 'utf-8')).toBe('# new workspace profile\n')
    expect(getWorkspaceMemorySummary(workspace.slug).workspaceProfile.path).toBe(profilePath)
  })

  test('旧版 .claude/memory 会复制到新的 .profer/memory，旧目录保留', () => {
    const workspace = createAgentWorkspace('Memory Compatibility')
    const workspaceRoot = join(configRoot, 'agent-workspaces', workspace.slug)
    const legacyMemoryPath = join(workspaceRoot, '.claude', 'memory', 'MEMORY.md')
    const newMemoryPath = join(workspaceRoot, '.profer', 'memory', 'MEMORY.md')
    mkdirSync(join(workspaceRoot, '.claude', 'memory'), { recursive: true })
    writeFileSync(legacyMemoryPath, '# legacy memory\n', 'utf-8')

    expect(getWorkspaceAutoMemoryDir(workspace.slug)).toBe(join(workspaceRoot, '.profer', 'memory'))
    expect(readFileSync(newMemoryPath, 'utf-8')).toBe('# legacy memory\n')
    expect(readFileSync(legacyMemoryPath, 'utf-8')).toBe('# legacy memory\n')
  })

  test('没有历史文件时写入 workspace-profile.md', () => {
    const workspace = createAgentWorkspace('New Profile')
    const profilePath = getWorkspaceProfilePath(workspace.slug)

    writeWorkspaceProfile(workspace.slug, '# profile\n')

    expect(readWorkspaceProfile(workspace.slug).relativePath).toBe('workspace-profile.md')
    expect(readFileSync(profilePath, 'utf-8')).toBe('# profile\n')
  })
})

describe('project 模式配置资产落点', () => {
  test('managed 工作区保持旧路径：profile 为 workspace-profile.md、memory 为 .profer/memory', () => {
    const workspace = createAgentWorkspace('Managed Paths')
    const workspaceRoot = join(configRoot, 'agent-workspaces', workspace.slug)

    expect(getWorkspaceProfilePath(workspace.slug)).toBe(join(workspaceRoot, 'workspace-profile.md'))
    expect(getWorkspaceAutoMemoryDir(workspace.slug)).toBe(join(workspaceRoot, '.profer', 'memory'))
  })

  test('project 工作区：profile 落 <root>/.profer/profile.md，memory 落 <root>/.profer/memory', () => {
    const rootPath = makeProjectRoot()
    writeProjectWorkspace(rootPath)

    const profilePath = getWorkspaceProfilePath('project-ws')
    const memoryDir = getWorkspaceAutoMemoryDir('project-ws')

    expect(profilePath).toBe(join(rootPath, '.profer', 'profile.md'))
    expect(memoryDir).toBe(join(rootPath, '.profer', 'memory'))
    // A3-2 遗留 bug：configDir 已经是 <root>/.profer，再拼一次 .profer 会得到双层目录。
    expect(profilePath).not.toContain(join('.profer', '.profer'))
    expect(memoryDir).not.toContain(join('.profer', '.profer'))
    expect(existsSync(join(rootPath, '.profer', '.profer'))).toBe(false)
  })

  test('project 工作区：旧名 workspace-profile.md 只读兼容，写入一律落 profile.md', () => {
    const rootPath = makeProjectRoot()
    writeProjectWorkspace(rootPath)
    const legacyPath = join(rootPath, '.profer', 'workspace-profile.md')
    mkdirSync(join(rootPath, '.profer'), { recursive: true })
    writeFileSync(legacyPath, '# legacy project profile\n', 'utf-8')

    expect(readWorkspaceProfile('project-ws').content).toBe('# legacy project profile\n')
    expect(getWorkspaceMemorySummary('project-ws').workspaceProfile.path).toBe(legacyPath)
    expect(readWorkspaceProfile('project-ws').relativePath).toBe('workspace-profile.md')

    writeWorkspaceProfile('project-ws', '# new project profile\n')

    expect(readFileSync(join(rootPath, '.profer', 'profile.md'), 'utf-8')).toBe('# new project profile\n')
    expect(readFileSync(legacyPath, 'utf-8')).toBe('# legacy project profile\n')
    expect(getWorkspaceMemorySummary('project-ws').workspaceProfile.path).toBe(join(rootPath, '.profer', 'profile.md'))
  })

  test('project 工作区：项目根的 CLAUDE.md 是用户项目指令，不被当成 Profer 资料读取', () => {
    const rootPath = makeProjectRoot()
    writeProjectWorkspace(rootPath)
    writeFileSync(join(rootPath, 'CLAUDE.md'), '# user project rules\n', 'utf-8')

    expect(readWorkspaceProfile('project-ws').content).toBe('')
    expect(readWorkspaceProfile('project-ws').relativePath).toBe('profile.md')
  })

  test('ensurePluginManifest：managed 建 .claude-plugin，project 不落入项目目录', () => {
    const managed = createAgentWorkspace('Managed Plugin')
    ensurePluginManifest(managed.slug, managed.name)
    expect(existsSync(join(configRoot, 'agent-workspaces', managed.slug, '.claude-plugin', 'plugin.json'))).toBe(true)

    const rootPath = makeProjectRoot()
    writeProjectWorkspace(rootPath)
    ensurePluginManifest('project-ws', '项目工作区')

    expect(existsSync(join(rootPath, '.profer', '.claude-plugin'))).toBe(false)
    expect(existsSync(join(rootPath, '.profer', 'plugin.json'))).toBe(false)
  })
})
