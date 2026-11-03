/**
 * agent-directory-utils 测试
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { collectAttachedDirectories, collectProductArtifactDirectories, isPathInsideDirectory } from './agent-directory-utils'

/** 在隔离配置根下写入一份含 project 条目的工作区索引。 */
function writeProjectWorkspaceIndex(configRoot: string, slug: string, rootPath: string): void {
  writeFileSync(join(configRoot, 'agent-workspaces.json'), JSON.stringify({
    version: 4,
    workspaces: [{
      id: randomUUID(),
      name: slug,
      slug,
      createdAt: 0,
      updatedAt: 0,
      type: 'personal',
      storageMode: 'project',
      rootPath,
    }],
  }), 'utf-8')
}

let testDir: string | undefined
let previousConfigRoot: string | undefined

beforeEach(() => {
  previousConfigRoot = process.env.PROFER_CONFIG_DIR
  testDir = mkdtempSync(join(tmpdir(), 'profer-agent-directory-utils-'))
  process.env.PROFER_CONFIG_DIR = testDir
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  if (testDir) rmSync(testDir, { recursive: true, force: true })
  testDir = undefined
  previousConfigRoot = undefined
})

describe('collectAttachedDirectories', () => {
  test('空参数返回空数组', () => {
    const result = collectAttachedDirectories({})
    expect(result).toEqual([])
  })

  test('extraDirs 去重', () => {
    const result = collectAttachedDirectories({
      extraDirs: ['/a', '/b', '/a'],
    })
    expect(result).toEqual(['/a', '/b'])
  })

  test('过滤 null/undefined', () => {
    const result = collectAttachedDirectories({
      extraDirs: ['/a', undefined as any, null as any, '/b'],
    })
    expect(result).toEqual(['/a', '/b'])
  })

  test('包含会话级 attachedDirectories', () => {
    const result = collectAttachedDirectories({
      sessionMeta: {
        id: 'test',
        title: 'Test',
        channelId: 'c1',
        attachedDirectories: ['/session-a'],
        attachedFiles: ['/session-a/file.txt'],
        createdAt: 0,
        updatedAt: 0,
      },
    })
    expect(result).toContain('/session-a')
  })

  test('会话级 attachedFiles 取其父目录', () => {
    const result = collectAttachedDirectories({
      sessionMeta: {
        id: 'test',
        title: 'Test',
        channelId: 'c1',
        attachedFiles: ['/parent/file.txt', '/other/doc.pdf'],
        createdAt: 0,
        updatedAt: 0,
      },
    })
    expect(result).toContain('/parent')
    expect(result).toContain('/other')
  })

  test('extraDirs + sessionMeta 合并去重', () => {
    const result = collectAttachedDirectories({
      extraDirs: ['/shared'],
      sessionMeta: {
        id: 'test',
        title: 'Test',
        channelId: 'c1',
        attachedDirectories: ['/shared'],
        attachedFiles: ['/unique/file.txt'],
        createdAt: 0,
        updatedAt: 0,
      },
    })
    expect(result).toEqual(['/shared', '/unique'])
  })

  test('工作区会加入根目录和 workspace-files，以读取 Profer 工作区资料', () => {
    const slug = `directory-utils-${randomUUID()}`
    const workspaceDir = getAgentWorkspacePath(slug)
    const result = collectAttachedDirectories({ workspaceSlug: slug })

    expect(result).toContain(workspaceDir)
    expect(result).toContain(getWorkspaceFilesDir(slug))
    // managed：工作区根与 workspace-files 都在同一配置目录下，不额外引入项目根或 runtimeDir。
    expect(result.filter((dir) => dir === workspaceDir)).toHaveLength(1)
    expect(result).not.toContain(join(workspaceDir, '.profer'))
  })

  test('project 工作区加入项目根与中央 runtimeDir，不重复加 configDir', () => {
    const slug = `directory-project-${randomUUID()}`
    const projectRoot = join(testDir!, 'project-root')
    mkdirSync(projectRoot, { recursive: true })
    writeProjectWorkspaceIndex(testDir!, slug, projectRoot)

    const result = collectAttachedDirectories({ workspaceSlug: slug })

    // locator 会对 rootPath 做 realpath 归一化（macOS 上 /var 会变成 /private/var）
    const canonicalRoot = realpathSync(projectRoot)
    const configDir = join(canonicalRoot, '.profer')
    const runtimeDir = join(testDir!, 'agent-workspaces', slug)
    // 项目根（Agent 需要访问项目）
    expect(result).toContain(canonicalRoot)
    // 中央 runtimeDir（附件/会话产物在这里，否则读不到附件）
    expect(result).toContain(runtimeDir)
    // configDir 在 rootPath 之内，不单独出现，也不出现「rootPath 内再套 agent-workspaces」的 managed 形状
    expect(result).not.toContain(configDir)
    expect(result).not.toContain(join(canonicalRoot, 'agent-workspaces'))
    // workspace-files 跟随 configDir（项目内 .profer）
    expect(result).toContain(join(configDir, 'workspace-files'))
  })

  test('project 工作区去重：rootPath 重复传入时只保留一次', () => {
    const slug = `directory-project-dup-${randomUUID()}`
    const projectRoot = join(testDir!, 'project-dup')
    mkdirSync(projectRoot, { recursive: true })
    writeProjectWorkspaceIndex(testDir!, slug, projectRoot)

    const canonicalRoot = realpathSync(projectRoot)
    const result = collectAttachedDirectories({ workspaceSlug: slug, extraDirs: [canonicalRoot] })

    expect(result.filter((dir) => dir === canonicalRoot)).toHaveLength(1)
    expect(result[0]).toBe(canonicalRoot)
  })
})

describe('collectProductArtifactDirectories', () => {
  test('只返回真实存在的产品目录', () => {
    mkdirSync(join(testDir!, 'skins'), { recursive: true })
    mkdirSync(join(testDir!, 'plugins'), { recursive: true })

    const result = collectProductArtifactDirectories()

    expect(result).toEqual([join(testDir!, 'skins'), join(testDir!, 'plugins')])
  })

  test('不包含配置与凭据文件（凭据目录不在清单内）', () => {
    mkdirSync(join(testDir!, 'skins'), { recursive: true })
    const result = collectProductArtifactDirectories()

    expect(result.some((dir) => dir.includes('channels') || dir.includes('auth-tokens') || dir.includes('sdk-config'))).toBe(false)
  })
})

describe('isPathInsideDirectory', () => {
  const sessionDir = '/Users/me/.profer/agent-workspaces/profer/0ad480b7'

  test('会话目录内的截图与临时产物判为内部路径', () => {
    expect(isPathInsideDirectory(`${sessionDir}/mem-v2.png`, sessionDir)).toBe(true)
    expect(isPathInsideDirectory(`${sessionDir}/.context/plan/x.md`, sessionDir)).toBe(true)
  })

  test('用户项目路径与同前缀兄弟目录不算内部', () => {
    expect(isPathInsideDirectory('/Users/me/profer/profer-main/src/a.ts', sessionDir)).toBe(false)
    expect(isPathInsideDirectory(`${sessionDir}-backup/a.ts`, sessionDir)).toBe(false)
  })

  test('目录自身与空值不算内部路径', () => {
    expect(isPathInsideDirectory(sessionDir, sessionDir)).toBe(false)
    expect(isPathInsideDirectory('', sessionDir)).toBe(false)
    expect(isPathInsideDirectory('/tmp/a.png', '')).toBe(false)
  })
})
