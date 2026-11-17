/**
 * WebUI `@` 文件候选的行为测试。
 * 安全边界：只返回相对会话根的 POSIX 路径，不暴露机器绝对路径；
 * 大目录（node_modules / .git）必须跳过。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMentionFileGroups, listWorkspaceFilesForMention } from './remote-file-mention'

const root = mkdtempSync(join(tmpdir(), 'profer-mention-'))
mkdirSync(join(root, 'src', 'deep'), { recursive: true })
mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
mkdirSync(join(root, '.git'), { recursive: true })
writeFileSync(join(root, 'README.md'), 'hello')
writeFileSync(join(root, 'src', 'main.ts'), 'export {}')
writeFileSync(join(root, 'src', 'deep', 'util.ts'), 'export {}')
writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('文件引用候选', () => {
  test('Given 授权根 When 列出 Then 只返回相对 POSIX 路径，不暴露绝对路径', () => {
    const paths = listWorkspaceFilesForMention(root, '').map((item) => item.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('src')
    expect(paths.every((path) => !path.includes(root))).toBe(true)
    expect(paths.every((path) => !path.includes('\\'))).toBe(true)
  })

  test('Given 大目录与隐藏目录 When 列出 Then 跳过', () => {
    const paths = listWorkspaceFilesForMention(root, '').map((item) => item.path)
    expect(paths).not.toContain('node_modules')
    expect(paths).not.toContain('.git')
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false)
  })

  test('Given 查询命中子目录文件 When 过滤 Then 仍能找到（BFS 会继续深入）', () => {
    expect(listWorkspaceFilesForMention(root, 'main.ts').map((item) => item.path)).toContain('src/main.ts')
    expect(listWorkspaceFilesForMention(root, 'deep/util').map((item) => item.path)).toContain('src/deep/util.ts')
  })

  test('Given 无命中 When 过滤 Then 空列表', () => {
    expect(listWorkspaceFilesForMention(root, 'zzzz-not-exist')).toEqual([])
  })

  test('Given 会话根与工作区根 When 分组列出 Then 工作区文件带 ../workspace-files/ 且各自标记来源', () => {
    const wsRoot = mkdtempSync(join(tmpdir(), 'profer-wsfiles-'))
    writeFileSync(join(wsRoot, 'shared.md'), 'shared')
    mkdirSync(join(wsRoot, 'assets'), { recursive: true })
    const groups = listMentionFileGroups(root, wsRoot, '')
    expect(groups.session.length).toBeGreaterThan(0)
    expect(groups.session.every((item) => item.source === 'session')).toBe(true)
    expect(groups.session.every((item) => !item.path.startsWith('..'))).toBe(true)
    // 工作区根不在会话根下 → 相对路径以 .. 开头，且不含机器绝对路径
    expect(groups.workspace.every((item) => item.path.startsWith('..'))).toBe(true)
    expect(groups.workspace.every((item) => !item.path.includes(wsRoot))).toBe(true)
    expect(groups.workspace.some((item) => item.path.endsWith('/shared.md'))).toBe(true)
    expect(groups.workspace.every((item) => item.source === 'workspace')).toBe(true)
    rmSync(wsRoot, { recursive: true, force: true })
  })

  test('Given .claude/.context 与其他隐藏目录 When 列出 Then 只保留前者（对齐桌面端）', () => {
    mkdirSync(join(root, '.context', 'goal'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    mkdirSync(join(root, '.secrets'), { recursive: true })
    const dirs = listWorkspaceFilesForMention(root, '')
      .filter((item) => item.type === 'dir')
      .map((item) => item.path)
    expect(dirs).toContain('.context')
    expect(dirs).toContain('.claude')
    expect(dirs).not.toContain('.secrets')
  })
})
