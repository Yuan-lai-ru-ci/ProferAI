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

/** project 工作区：根目录下自带 `.profer` 配置目录，内部条目不该出现在 `@` 搜索结果里。 */
describe('project 工作区的 .profer 内部条目过滤', () => {
  let projectRoot = ''
  let projectFilesDir = ''
  /** `.profer` 下必须被剪掉的内部条目（目录与文件） */
  const internalEntries = [
    'presets',
    'skills',
    'skills-inactive',
    'sessions',
    'cache',
    '.claude-plugin',
    'config.json',
    'mcp.json',
    'mcp.local.json',
  ]

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'profer-remote-search-project-'))
    projectFilesDir = join(projectRoot, '.profer', 'workspace-files')
    // 用户自己会引用的内容
    write(join(projectRoot, 'README.md'), '# demo')
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    write(join(projectRoot, 'src', 'app.ts'))
    mkdirSync(join(projectRoot, '.profer'), { recursive: true })
    write(join(projectRoot, '.profer', 'profile.md'))
    mkdirSync(join(projectRoot, '.profer', 'memory'), { recursive: true })
    write(join(projectRoot, '.profer', 'memory', 'note.md'))
    mkdirSync(projectFilesDir, { recursive: true })
    write(join(projectFilesDir, 'guide.md'))

    // Profer 内部状态
    mkdirSync(join(projectRoot, '.profer', 'presets'), { recursive: true })
    write(join(projectRoot, '.profer', 'presets', '_config.json'))
    mkdirSync(join(projectRoot, '.profer', 'skills', 'demo-skill'), { recursive: true })
    write(join(projectRoot, '.profer', 'skills', 'demo-skill', 'SKILL.md'))
    mkdirSync(join(projectRoot, '.profer', 'skills-inactive', 'old-skill'), { recursive: true })
    write(join(projectRoot, '.profer', 'skills-inactive', 'old-skill', 'SKILL.md'))
    mkdirSync(join(projectRoot, '.profer', 'sessions', 'sess-1'), { recursive: true })
    write(join(projectRoot, '.profer', 'sessions', 'sess-1', 'messages.jsonl'))
    mkdirSync(join(projectRoot, '.profer', 'cache'), { recursive: true })
    write(join(projectRoot, '.profer', 'cache', 'blob.bin'))
    mkdirSync(join(projectRoot, '.profer', '.claude-plugin'), { recursive: true })
    write(join(projectRoot, '.profer', '.claude-plugin', 'plugin.json'))
    write(join(projectRoot, '.profer', 'config.json'), '{}')
    write(join(projectRoot, '.profer', 'mcp.json'), '{}')
    write(join(projectRoot, '.profer', 'mcp.local.json'), '{}')
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  test('project 搜索不出现 presets/skills/sessions 等内部目录', () => {
    const result = searchRemoteWorkspaceFiles({
      sessionRoot: projectRoot,
      workspaceRoot: projectFilesDir,
      query: '',
      isProjectWorkspace: true,
    })
    const names = result.sessionEntries.map((entry) => entry.name)

    for (const name of internalEntries) {
      expect(names).not.toContain(name)
    }
    const allPaths = result.entries.map((entry) => entry.path)
    expect(allPaths.some((path) => path.includes(join('.profer', 'presets')))).toBe(false)
    expect(allPaths.some((path) => path.includes(join('.profer', 'skills')))).toBe(false)
    expect(allPaths.some((path) => path.includes(join('.profer', 'sessions')))).toBe(false)
    // 项目自身文件不受影响
    expect(names).toContain('README.md')
    expect(names).toContain('src')
    expect(names).toContain('app.ts')
  })

  test('project 搜索仍保留 profile.md / memory / workspace-files', () => {
    const result = searchRemoteWorkspaceFiles({
      sessionRoot: projectRoot,
      workspaceRoot: projectFilesDir,
      query: '',
      isProjectWorkspace: true,
    })
    const sessionPaths = result.sessionEntries.map((entry) => entry.path)

    expect(sessionPaths).toContain(join('.profer', 'profile.md'))
    expect(sessionPaths).toContain(join('.profer', 'memory'))
    expect(sessionPaths).toContain(join('.profer', 'memory', 'note.md'))
    // workspace 组：工作区文件目录仍是根条目
    expect(result.workspaceEntries[0]).toMatchObject({ name: '工作文件', path: projectFilesDir, type: 'dir' })
    expect(result.workspaceEntries.map((entry) => entry.path)).toContain(join(projectFilesDir, 'guide.md'))
  })

  test('project 搜索 query 命中内部目录名时也不返回条目', () => {
    for (const query of ['presets', 'skills', 'sessions', 'cache', 'mcp']) {
      const result = searchRemoteWorkspaceFiles({
        sessionRoot: projectRoot,
        workspaceRoot: projectFilesDir,
        query,
        isProjectWorkspace: true,
      })
      const names = result.sessionEntries.map((entry) => entry.name)
      expect(names).not.toContain('presets')
      expect(names).not.toContain('skills')
      expect(names).not.toContain('sessions')
      expect(names).not.toContain('cache')
      expect(names.some((name) => name.startsWith('mcp'))).toBe(false)
      expect(result.sessionEntries.some((entry) => entry.path.includes(join('.profer', 'presets')))).toBe(false)
    }
  })

  test('project 搜索仍能命中 profile.md / memory', () => {
    const result = searchRemoteWorkspaceFiles({
      sessionRoot: projectRoot,
      workspaceRoot: projectFilesDir,
      query: 'profile',
      isProjectWorkspace: true,
    })
    expect(result.sessionEntries.map((entry) => entry.path)).toContain(join('.profer', 'profile.md'))
  })

  test('managed（不传 isProjectWorkspace）扫描结果不变：同名内部目录仍出现', () => {
    const result = searchRemoteWorkspaceFiles({
      sessionRoot: projectRoot,
      workspaceRoot: projectFilesDir,
      query: '',
    })
    const names = result.sessionEntries.map((entry) => entry.name)

    expect(names).toContain('presets')
    expect(names).toContain('skills')
    expect(names).toContain('sessions')
    expect(names).toContain('cache')
    expect(names.some((name) => name.startsWith('mcp'))).toBe(true)
  })
})
