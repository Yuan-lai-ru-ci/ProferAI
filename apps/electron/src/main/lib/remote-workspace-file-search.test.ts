import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchRemoteWorkspaceFiles } from './remote-workspace-file-search'

let root = ''
let sessionRoot = ''
let workspaceRoot = ''
let attachedDir = ''

function write(path: string, content = 'x'): void {
  writeFileSync(path, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-remote-search-'))
  sessionRoot = join(root, 'session')
  workspaceRoot = join(root, 'workspace-files')
  attachedDir = join(root, 'attached')
  mkdirSync(join(sessionRoot, 'src'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'docs'), { recursive: true })
  mkdirSync(join(attachedDir, 'nested'), { recursive: true })
  write(join(sessionRoot, 'index.ts'))
  write(join(sessionRoot, 'src', 'app.ts'))
  write(join(sessionRoot, 'README.md'))
  write(join(workspaceRoot, 'docs', 'guide.md'))
  write(join(attachedDir, 'nested', 'extra.md'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('searchRemoteWorkspaceFiles', () => {
  test('空 query 返回 session（相对路径）+ workspace（绝对路径）两组条目', () => {
    const result = searchRemoteWorkspaceFiles({ sessionRoot, workspaceRoot, query: '' })

    const sessionPaths = result.sessionEntries.map((entry) => entry.path).sort()
    const expectedSessionPaths = ['README.md', 'index.ts', 'src', join('src', 'app.ts')].sort()
    expect(sessionPaths).toEqual(expectedSessionPaths)
    expect(result.sessionEntries.every((entry) => entry.source === 'session')).toBe(true)

    expect(result.workspaceEntries).toHaveLength(3)
    expect(result.workspaceEntries[0]).toMatchObject({
      name: '工作文件',
      path: workspaceRoot,
      type: 'dir',
      source: 'workspace',
    })
    expect(result.workspaceEntries.map((entry) => entry.path)).toContain(join(workspaceRoot, 'docs', 'guide.md'))
    expect(result.entries.length).toBe(result.sessionEntries.length + result.workspaceEntries.length)
    expect(result.total).toBe(4 + 3)
  })

  test('query 命中 session 组：前缀目录优先，不匹配的组返回空', () => {
    const result = searchRemoteWorkspaceFiles({
      sessionRoot,
      workspaceRoot,
      query: 'src',
      sessionAttachedPaths: [attachedDir],
    })

    // src 目录及其下 app.ts 命中（名字 / 路径子串），workspace 组与附加目录均不命中
    expect(result.sessionEntries.map((entry) => entry.path).sort())
      .toEqual(['src', join('src', 'app.ts')].sort())
    expect(result.sessionEntries[0]?.type).toBe('dir')
    expect(result.workspaceEntries).toHaveLength(0)
  })

  test('附加目录 / 附加文件以绝对路径进入对应分组，且忽略目录被跳过', () => {
    mkdirSync(join(sessionRoot, 'node_modules', 'pkg'), { recursive: true })
    write(join(sessionRoot, 'node_modules', 'pkg', 'index.js'))
    const attachedFile = join(root, 'standalone.txt')
    write(attachedFile)

    const result = searchRemoteWorkspaceFiles({
      sessionRoot,
      workspaceRoot,
      query: '',
      sessionAttachedPaths: [attachedDir, attachedFile],
    })

    const names = result.sessionEntries.map((entry) => entry.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('index.js')

    const attachedEntry = result.sessionEntries.find((entry) => entry.name === 'standalone.txt')
    expect(attachedEntry?.path).toBe(attachedFile)
    expect(attachedEntry?.type).toBe('file')

    const extraEntry = result.sessionEntries.find((entry) => entry.name === 'extra.md')
    expect(extraEntry?.path).toBe(join(attachedDir, 'nested', 'extra.md'))
    expect(extraEntry?.source).toBe('session')
  })

  test('不存在的 roots 不抛错，仅返回可读部分', () => {
    const result = searchRemoteWorkspaceFiles({
      sessionRoot: join(root, 'missing-session'),
      workspaceRoot: join(root, 'missing-workspace'),
      query: '',
    })
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
  })

  test('limit 生效时按两组命中占比分配配额', () => {
    const result = searchRemoteWorkspaceFiles({ sessionRoot, workspaceRoot, query: 'a', limit: 2 })
    expect(result.entries.length).toBeLessThanOrEqual(2)
    expect(result.sessionEntries.length + result.workspaceEntries.length).toBe(result.entries.length)
  })

  test('返回条目仅来自传入的授权根，不泄露根目录之外的路径', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    write(join(outside, 'secret.ts'))

    const result = searchRemoteWorkspaceFiles({ sessionRoot, workspaceRoot, query: '' })
    const allPaths = [...result.sessionEntries, ...result.workspaceEntries].map((entry) => entry.path)
    expect(allPaths.some((path) => path.includes('secret.ts'))).toBe(false)
    expect(allPaths.length).toBeGreaterThan(0)
  })
})
