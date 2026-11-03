/**
 * 桌面端 `@` 搜索（SEARCH_WORKSPACE_FILES）的 project 过滤
 *
 * 背景（审查报告 §3 P2）：远端 `searchRemoteWorkspaceFiles` 已剪掉 `<root>/.profer` 下的
 * Profer 内部条目，桌面 `ipc.ts` 的 SEARCH_WORKSPACE_FILES 只 ignore node_modules/.git，
 * 于是 `@` 里能看到 `.profer/presets/*.json`、`.profer/sessions/**`、`mcp.local.json`
 * 等内部状态（噪声 + 暴露用户的 MCP 配置文件名）。
 *
 * 现在桌面 handler 的递归扫描与远端共用 `scanWorkspaceRoot`，project 判定用
 * `isProjectWorkspaceRootPath`（在 workspace-locator.test.ts 覆盖），过滤谓词为
 * `shouldSkipProjectInternalEntry`。本文件直接跑桌面端同一份扫描实现：
 * - project：内部目录/文件消失，profile.md / memory / workspace-files 保留；
 * - managed（不传 projectInternalDir）：结果逐字不变，内部条目仍在。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  PROJECT_INTERNAL_ENTRY_NAMES,
  resolveProjectInternalEntryDir,
  scanWorkspaceRoot,
  shouldSkipProjectInternalEntry,
} from './remote-workspace-file-search'

let root = ''
let projectRoot = ''

function write(path: string, content = 'x'): void {
  writeFileSync(path, content)
}

/** `.profer` 下必须被剪掉的内部条目（目录与文件）。 */
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
  root = mkdtempSync(join(tmpdir(), 'profer-desktop-search-'))
  projectRoot = join(root, 'project')
  mkdirSync(projectRoot, { recursive: true })

  // 项目自身文件
  write(join(projectRoot, 'README.md'), '# demo')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  write(join(projectRoot, 'src', 'app.ts'))
  // 名字与内部目录相同，但不在 `.profer` 这一层：必须保留
  mkdirSync(join(projectRoot, 'docs', 'presets'), { recursive: true })
  write(join(projectRoot, 'docs', 'presets', 'keep.md'))

  // `.profer` 里用户会主动引用的内容
  mkdirSync(join(projectRoot, '.profer'), { recursive: true })
  write(join(projectRoot, '.profer', 'profile.md'))
  mkdirSync(join(projectRoot, '.profer', 'memory'), { recursive: true })
  write(join(projectRoot, '.profer', 'memory', 'note.md'))
  mkdirSync(join(projectRoot, '.profer', 'workspace-files'), { recursive: true })
  write(join(projectRoot, '.profer', 'workspace-files', 'guide.md'))

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
  rmSync(root, { recursive: true, force: true })
})

/** 复刻桌面 handler：session 根用相对路径，project 时传 `<root>/.profer`。 */
function scanAsDesktopSearch(projectInternalDir?: string) {
  return scanWorkspaceRoot(projectRoot, {
    baseRoot: projectRoot,
    useAbsolutePath: false,
    source: 'session',
    projectInternalDir,
  })
}

describe('project 工作区（桌面 @ 搜索）', () => {
  test('不出现 presets/skills/sessions 等内部条目', () => {
    const entries = scanAsDesktopSearch(resolveProjectInternalEntryDir(projectRoot))
    // 只看 `.profer` 这一层的条目（项目自身的 docs/presets 不在过滤范围）
    const internalPaths = entries
      .map((entry) => entry.path)
      .filter((path) => path === '.profer' || path.startsWith(`.profer${sep}`))
    const internalNames = entries
      .filter((entry) => entry.path === '.profer' || entry.path.startsWith(`.profer${sep}`))
      .map((entry) => entry.name)
    const paths = entries.map((entry) => entry.path)

    for (const name of internalEntries) {
      expect(internalNames).not.toContain(name)
    }
    expect(internalPaths).toEqual([
      '.profer',
      join('.profer', 'memory'),
      join('.profer', 'memory', 'note.md'),
      join('.profer', 'workspace-files'),
      join('.profer', 'workspace-files', 'guide.md'),
      join('.profer', 'profile.md'),
    ])
    expect(paths.some((path) => path.startsWith(join('.profer', 'presets')))).toBe(false)
    expect(paths.some((path) => path.startsWith(join('.profer', 'skills')))).toBe(false)
    expect(paths.some((path) => path.startsWith(join('.profer', 'sessions')))).toBe(false)
    expect(paths.some((path) => path.includes('mcp.local.json'))).toBe(false)
    expect(paths.some((path) => path.includes('messages.jsonl'))).toBe(false)
  })

  test('保留 profile.md / memory / workspace-files 与项目自身文件', () => {
    const entries = scanAsDesktopSearch(resolveProjectInternalEntryDir(projectRoot))
    const paths = entries.map((entry) => entry.path)

    expect(paths).toContain(join('.profer', 'profile.md'))
    expect(paths).toContain(join('.profer', 'memory'))
    expect(paths).toContain(join('.profer', 'memory', 'note.md'))
    expect(paths).toContain(join('.profer', 'workspace-files'))
    expect(paths).toContain(join('.profer', 'workspace-files', 'guide.md'))
    expect(paths).toContain('README.md')
    expect(paths).toContain('src')
    expect(paths).toContain(join('src', 'app.ts'))
  })

  test('只剪 `.profer` 这一层：项目里同名目录（docs/presets）照常返回', () => {
    const entries = scanAsDesktopSearch(resolveProjectInternalEntryDir(projectRoot))
    const paths = entries.map((entry) => entry.path)

    expect(paths).toContain(join('docs', 'presets'))
    expect(paths).toContain(join('docs', 'presets', 'keep.md'))
  })

  test('谓词边界：仅当目录正好是 `<root>/.profer` 才命中', () => {
    const internalDir = resolveProjectInternalEntryDir(projectRoot)

    expect(shouldSkipProjectInternalEntry(internalDir, 'presets', internalDir)).toBe(true)
    expect(shouldSkipProjectInternalEntry(internalDir, 'profile.md', internalDir)).toBe(false)
    expect(shouldSkipProjectInternalEntry(join(projectRoot, 'docs'), 'presets', internalDir)).toBe(false)
    expect(shouldSkipProjectInternalEntry(internalDir, 'presets', undefined)).toBe(false)
    expect(PROJECT_INTERNAL_ENTRY_NAMES.has('mcp.local.json')).toBe(true)
    expect(PROJECT_INTERNAL_ENTRY_NAMES.has('profile.md')).toBe(false)
  })
})

describe('managed 工作区（桌面 @ 搜索）结果逐字不变', () => {
  test('不传 projectInternalDir 时内部条目仍在（与改造前一致）', () => {
    const entries = scanAsDesktopSearch(undefined)
    const names = entries.map((entry) => entry.name)
    const paths = entries.map((entry) => entry.path)

    for (const name of internalEntries) {
      expect(names).toContain(name)
    }
    expect(paths).toContain(join('.profer', 'presets', '_config.json'))
    expect(paths).toContain(join('.profer', 'sessions', 'sess-1', 'messages.jsonl'))
  })
})

describe('IPC 接线（tripwire）', () => {
  test('SEARCH_WORKSPACE_FILES 使用共享扫描 + project 判定（行为测试在上一组）', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'ipc.ts'), 'utf-8')
    const handlerStart = source.indexOf('AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES')

    expect(handlerStart).toBeGreaterThan(-1)
    const handler = source.slice(handlerStart, handlerStart + 6000)
    expect(handler).toContain('isProjectWorkspaceRootPath(safeRoot)')
    expect(handler).toContain('resolveProjectInternalEntryDir(safeRoot)')
    expect(handler).toContain('scanWorkspaceRoot(')
    expect(handler).toContain('projectInternalDir')
  })
})
