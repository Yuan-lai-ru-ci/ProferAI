import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  copyForkWorkspaceFiles,
  shouldCopyForkWorkspacePath,
} from './agent-fork-workspace-copy'
import { buildForkProjectKey } from './fork-file-ops'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-fork-copy-'))
  tempRoots.push(root)
  return root
}

function writeFile(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!
    rmSync(root, { recursive: true, force: true })
  }
})

describe('fork 工作区复制', () => {
  test('Given 会话目录包含上下文和依赖目录 When 复制 fork 工作区 Then 保留 .context 并跳过高风险目录', () => {
    const root = makeTempRoot()
    const sourceDir = join(root, 'source')
    const destDir = join(root, 'dest')

    writeFile(join(sourceDir, '.context', 'note.md'), 'keep')
    writeFile(join(sourceDir, '.claude', 'settings.json'), '{}')
    writeFile(join(sourceDir, 'node_modules', 'pkg', 'index.js'))
    writeFile(join(sourceDir, '.venv', 'pyvenv.cfg'))
    writeFile(join(sourceDir, 'dist', 'bundle.js'))
    writeFile(join(sourceDir, 'build', 'generated-or-source.cpp'))
    writeFile(join(sourceDir, 'out', 'source-or-artifact.txt'))
    writeFile(join(sourceDir, 'src', 'index.ts'), 'export {}')
    writeFile(join(sourceDir, 'nested-repo', '.git', 'config'))
    writeFile(join(sourceDir, 'nested-repo', 'src', 'file.ts'), 'export const ok = true')

    const result = copyForkWorkspaceFiles(sourceDir, destDir)

    expect(result.copiedCount).toBe(6)
    expect(result.skippedCount).toBe(3)
    expect(result.failedCount).toBe(0)
    expect(existsSync(join(destDir, '.context', 'note.md'))).toBe(true)
    expect(existsSync(join(destDir, 'src', 'index.ts'))).toBe(true)
    expect(existsSync(join(destDir, 'build', 'generated-or-source.cpp'))).toBe(true)
    expect(existsSync(join(destDir, 'out', 'source-or-artifact.txt'))).toBe(true)
    expect(existsSync(join(destDir, 'dist', 'bundle.js'))).toBe(true)
    expect(existsSync(join(destDir, 'nested-repo', 'src', 'file.ts'))).toBe(true)
    expect(existsSync(join(destDir, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(destDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(destDir, '.venv'))).toBe(false)
    expect(existsSync(join(destDir, 'nested-repo', '.git'))).toBe(false)
  })

  test('Given 源目录不存在 When 复制 fork 工作区 Then 返回结构化失败路径而不是抛异常', () => {
    const root = makeTempRoot()
    const sourceDir = join(root, 'missing-source')
    const destDir = join(root, 'dest')

    const result = copyForkWorkspaceFiles(sourceDir, destDir)

    expect(result.copiedCount).toBe(0)
    expect(result.skippedCount).toBe(0)
    expect(result.failedCount).toBe(1)
    expect(result.failedPaths).toEqual([{ path: sourceDir, reason: expect.stringContaining('ENOENT') }])
  })

  test('Given Windows 风格的超长工作区路径 When 生成 project key Then 长度受控且稳定', () => {
    const longPath = `C:/Users/test/${'nested/'.repeat(80)}session`
    const first = buildForkProjectKey(longPath)
    const second = buildForkProjectKey(longPath)

    expect(first).toBe(second)
    expect(first.length).toBeLessThanOrEqual(240)
  })

  test('Given 路径是会话上下文或依赖目录 When 判断是否复制 Then 只放行上下文', () => {
    expect(shouldCopyForkWorkspacePath('/tmp/session/.context')).toBe(true)
    expect(shouldCopyForkWorkspacePath('/tmp/session/.claude')).toBe(false)
    expect(shouldCopyForkWorkspacePath('/tmp/session/node_modules')).toBe(false)
    expect(shouldCopyForkWorkspacePath('/tmp/session/build')).toBe(true)
    expect(shouldCopyForkWorkspacePath('/tmp/session/out')).toBe(true)
    expect(shouldCopyForkWorkspacePath('/tmp/session/.git')).toBe(false)
  })
})
