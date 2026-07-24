/**
 * agent-directory-utils 测试
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { collectAttachedDirectories } from './agent-directory-utils'

const testDir = join(homedir(), '.profer-test-tmp')

beforeEach(() => {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
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

  test('工作区会加入根目录和 workspace-files，以读取工作区 CLAUDE.md', () => {
    const slug = `directory-utils-${randomUUID()}`
    const workspaceDir = getAgentWorkspacePath(slug)
    try {
      const result = collectAttachedDirectories({ workspaceSlug: slug })

      expect(result).toContain(workspaceDir)
      expect(result).toContain(getWorkspaceFilesDir(slug))
    } finally {
      if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true, force: true })
    }
  })
})
