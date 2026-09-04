import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const {
  createAgentWorkspace,
  getWorkspaceMemorySummary,
  getWorkspaceProfilePath,
  getWorkspaceAutoMemoryDir,
  readWorkspaceProfile,
  writeWorkspaceProfile,
} = await import('./agent-workspace-manager')

let configRoot = ''
const previousConfigRoot = process.env.PROFER_CONFIG_DIR

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'profer-workspace-profile-'))
  process.env.PROFER_CONFIG_DIR = configRoot
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(configRoot, { recursive: true, force: true })
})

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
