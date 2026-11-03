/**
 * P0-A3-3b：文件预览全局搜索根按存储模式分流
 *
 * 相对路径的 fallback 搜索只能落在「用户的项目」与「会话运行目录」里：
 * - managed：工作区配置目录 + 一层会话目录（改造前行为）；
 * - project：项目根 rootPath（不是中央 `~/.profer/agent-workspaces/<slug>`）+ 具体会话运行目录。
 *
 * 反例（本文件的红线）：把中央工作区壳目录当项目根搜索，
 * 会让「项目里找不到的文件」悄悄解析到 Profer 自己的运行时目录。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-preview-search-roots-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { resolveTargetPath, resetGlobalSearchDirsCache } = await import('./file-preview-service')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const workspacesDir = join(configRoot, 'agent-workspaces')
const indexPaths = [
  join(configRoot, 'agent-workspaces.json'),
  join(configRoot, 'agent-sessions.json'),
]

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of indexPaths) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
  }
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
  resetGlobalSearchDirsCache()
})

function writeFile(path: string, content = 'x\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  return path
}

function writeWorkspacesIndex(workspaces: Array<Record<string, unknown>>): void {
  writeFile(join(configRoot, 'agent-workspaces.json'), JSON.stringify({ version: 4, workspaces }))
  invalidateWorkspaceLocation()
  resetGlobalSearchDirsCache()
}

function managedEntry(slug: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function projectEntry(slug: string, rootPath: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

/** 建一个真实存在的项目根（索引里存 realpath，与 locator 归一化一致）。 */
function makeProjectRoot(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(root, { recursive: true })
  return realpathSync(root)
}

describe('managed：搜索根 = 工作区配置目录 + 会话目录', () => {
  test('Given managed 工作区 When 裸文件名只存在于会话目录 Then 能在工作区下命中', () => {
    writeWorkspacesIndex([managedEntry('managed-a')])
    const sessionFile = writeFile(join(workspacesDir, 'managed-a', 'session-1', 'managed-only.txt'))
    const rootFile = writeFile(join(workspacesDir, 'managed-a', 'managed-root.txt'))

    // managed 的搜索根本身就是 `<config>/agent-workspaces/<slug>`（路径不经过 realpath 归一化）
    expect(resolveTargetPath('managed-only.txt')).toBe(sessionFile)
    expect(resolveTargetPath('managed-root.txt')).toBe(rootFile)
  })
})

describe('project：搜索根 = rootPath，不是中央工作区壳', () => {
  test('Given project 工作区 When 裸文件名在项目根 Then 命中项目内的文件', () => {
    const projectRoot = makeProjectRoot('p1')
    const projectFile = writeFile(join(projectRoot, 'src', 'project-only.txt'))
    writeWorkspacesIndex([projectEntry('p1', projectRoot), managedEntry('managed-a')])

    expect(resolveTargetPath('project-only.txt')).toBe(projectFile)
  })

  test('Given project 工作区 When 裸文件名只在中央工作区壳目录 Then 不把它当项目根搜索', () => {
    const projectRoot = makeProjectRoot('p2')
    writeWorkspacesIndex([projectEntry('p2', projectRoot), managedEntry('managed-a')])
    // 中央工作区壳（`<config>/agent-workspaces/p2`）里的文件不是用户项目文件
    const trapFile = writeFile(join(workspacesDir, 'p2', 'runtime-shell-only.txt'))

    expect(resolveTargetPath('runtime-shell-only.txt')).not.toBe(trapFile)
    expect(resolveTargetPath('runtime-shell-only.txt')).not.toBe(realpathSync(trapFile))
  })

  test('Given project 工作区 When 文件在会话运行目录（附件） Then 仍然可预览', () => {
    const projectRoot = makeProjectRoot('p3')
    writeWorkspacesIndex([projectEntry('p3', projectRoot), managedEntry('managed-a')])
    const attachment = writeFile(join(workspacesDir, 'p3', 'sessions', 'session-9', 'attachment-note.txt'))

    expect(resolveTargetPath('attachment-note.txt')).toBe(attachment)
  })
})
