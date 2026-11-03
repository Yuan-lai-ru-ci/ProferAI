/**
 * P1-7：远程/Pocket 在 project 工作区下必须能读到「用户项目文件」
 *
 * 事故形态（审查报告 §2 P1-7）：`search_workspace_files` 与 `resolve_and_read_file` 的
 * roots 全部取自 `getAgentSessionWorkspacePath`（storageDir）与 `getAgentWorkspacePath`（configDir）。
 * project 下这两个都不是项目根（`<root>/.profer` / 中央 `sessions/<sid>`），于是移动端在项目里
 * 「什么都搜不到」，桌面端却正常。
 *
 * 本文件锁四条不变量：
 * 1. project：`@` 检索命中 `src/**` 等项目文件，且条目是**相对项目根**的相对路径；
 * 2. project：storageDir（会话附件/产物）仍是授权根，搜索可见、读取可用；
 * 3. managed：roots 与条目**逐字不变**（sessionRoot 仍是 storageDir，不含 rootPath 扫描）；
 * 4. 授权边界不扩大：项目外文件、其他工作区目录、`..` 越界一律被拒。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { FileIndexEntry, FileSearchResult } from '@profer/shared'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-remote-project-roots-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const PROJECT_SLUG = 'demo'
const PROJECT_WORKSPACE_ID = 'id-demo'
const PROJECT_SESSION_ID = 'sess-p1'
const MANAGED_SLUG = 'm1'
const MANAGED_WORKSPACE_ID = 'id-m1'
const MANAGED_SESSION_ID = 'sess-m1'

const workspacesDir = join(configRoot, 'agent-workspaces')

let projectRoot = ''
/** project 会话的中央 storageDir（附件 / 会话产物），永远不在项目内。 */
let projectStorageDir = ''
let managedStorageDir = ''
let managedFilesDir = ''
let outsideFile = ''
let otherWorkspaceFile = ''

let handleRemoteCommand: typeof import('./remote-service')['handleRemoteCommand']

function writeFile(path: string, content = 'x\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  return path
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, JSON.stringify(value))
}

/** 建一个真实存在的项目根（索引里存 realpath，与 locator 归一化一致）。 */
function makeProjectRoot(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(root, { recursive: true })
  return realpathSync(root)
}

function searchData(result: Awaited<ReturnType<typeof handleRemoteCommand>>): FileSearchResult {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`预期成功，实际失败：${result.error}`)
  return result.data as FileSearchResult
}

async function search(sessionId: string, query = ''): Promise<FileSearchResult> {
  return searchData(await handleRemoteCommand(
    JSON.stringify({ type: 'search_workspace_files', sessionId, query }),
    1,
  ))
}

beforeAll(async () => {
  projectRoot = makeProjectRoot('demo')
  // 项目里「用户自己的文件」——移动端过去完全看不到这些
  writeFile(join(projectRoot, 'src', 'app.ts'), 'export const app = 1\n')
  writeFile(join(projectRoot, 'src', 'nested', 'deep.ts'), 'export const deep = 1\n')
  writeFile(join(projectRoot, 'README.md'), '# demo\n')
  writeFile(join(projectRoot, 'package.json'), '{"name":"demo"}\n')
  // 项目的工作区文件目录（configDir 内，属于 Profer 私有资产，但仍是合法 root）
  writeFile(join(projectRoot, '.profer', 'workspace-files', 'docs', 'guide.md'), 'guide\n')
  // Profer 内部状态：用户不该在 `@` 引用里看到这些
  writeFile(join(projectRoot, '.profer', 'presets', '_config.json'), '{}\n')
  writeFile(join(projectRoot, '.profer', 'skills', 'demo-skill', 'SKILL.md'), '# demo\n')
  writeFile(join(projectRoot, '.profer', 'sessions', 'sess-x', 'messages.jsonl'), '{}\n')
  writeFile(join(projectRoot, '.profer', 'cache', 'blob.bin'), 'bin\n')
  // 用户会主动引用的内容：保留
  writeFile(join(projectRoot, '.profer', 'profile.md'), '# profile\n')
  writeFile(join(projectRoot, '.profer', 'memory', 'note.md'), 'memo\n')

  // project 的会话存储目录：中央 runtimeDir/<slug>/sessions/<sid>
  projectStorageDir = join(workspacesDir, PROJECT_SLUG, 'sessions', PROJECT_SESSION_ID)
  writeFile(join(projectStorageDir, 'note-attachment.md'), 'attachment\n')

  // managed 工作区：storageDir = configDir/<sid>，与改造前一致
  managedStorageDir = join(workspacesDir, MANAGED_SLUG, MANAGED_SESSION_ID)
  managedFilesDir = join(workspacesDir, MANAGED_SLUG, 'workspace-files')
  writeFile(join(managedStorageDir, 'managed.ts'), 'export const m = 1\n')
  writeFile(join(managedFilesDir, 'docs', 'm.md'), 'managed doc\n')

  // 授权边界外的诱饵：项目外文件、另一个工作区目录
  outsideFile = writeFile(join(sandbox, 'outside-secret.ts'), 'secret\n')
  otherWorkspaceFile = writeFile(join(workspacesDir, 'other-workspace', 'other.ts'), 'other\n')

  writeJson(join(configRoot, 'agent-workspaces.json'), {
    version: 4,
    workspaces: [
      { id: PROJECT_WORKSPACE_ID, name: 'demo', slug: PROJECT_SLUG, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: projectRoot },
      { id: MANAGED_WORKSPACE_ID, name: 'm1', slug: MANAGED_SLUG, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' },
    ],
  })
  writeJson(join(configRoot, 'agent-sessions.json'), {
    version: 1,
    sessions: [
      { id: PROJECT_SESSION_ID, title: 'project session', workspaceId: PROJECT_WORKSPACE_ID, createdAt: 1, updatedAt: 1 },
      { id: MANAGED_SESSION_ID, title: 'managed session', workspaceId: MANAGED_WORKSPACE_ID, createdAt: 1, updatedAt: 1 },
    ],
  })

  ;({ handleRemoteCommand } = await import('./remote-service'))
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('project：远程搜索根 = 项目根', () => {
  test('Given project 会话 When 搜索项目文件 Then 命中 src/**，条目为相对项目根的相对路径', async () => {
    const data = await search(PROJECT_SESSION_ID, 'app')

    expect(data.sessionEntries.map((entry) => entry.path)).toContain(join('src', 'app.ts'))
    expect(data.sessionEntries.every((entry) => entry.source === 'session')).toBe(true)
    // 相对路径 = 扫描基准确实是 rootPath；用 storageDir/configDir 当根时这里会是绝对路径或干脆命中不到
    expect(data.sessionEntries.every((entry) => !entry.path.startsWith('/') && !entry.path.startsWith(projectRoot))).toBe(true)
  })

  test('Given project 会话 When 空 query 浏览 Then 顶层即为项目结构，且不泄露项目外文件', async () => {
    const data = await search(PROJECT_SESSION_ID, '')
    const sessionPaths = data.sessionEntries.map((entry) => entry.path)

    expect(sessionPaths).toContain('src')
    expect(sessionPaths).toContain(join('src', 'nested'))
    expect(sessionPaths).toContain(join('src', 'nested', 'deep.ts'))
    expect(sessionPaths).toContain('README.md')
    expect(sessionPaths).toContain('package.json')

    const allPaths = (data.entries as FileIndexEntry[]).map((entry) => entry.path)
    expect(allPaths.some((path) => path.includes('outside-secret'))).toBe(false)
    expect(allPaths.some((path) => path.includes('other-workspace'))).toBe(false)
  })

  test('Given project 会话 When 搜索 Then storageDir 附件仍以绝对路径出现在会话组', async () => {
    const data = await search(PROJECT_SESSION_ID, 'note-attachment')

    const attachment = data.sessionEntries.find((entry) => entry.name === 'note-attachment.md')
    expect(attachment).toBeDefined()
    expect(attachment?.path).toBe(join(projectStorageDir, 'note-attachment.md'))
    expect(attachment?.source).toBe('session')
  })

  test('Given project 会话 When 搜索 Then .profer 内部目录被剪掉，profile.md / memory / workspace-files 保留', async () => {
    const data = await search(PROJECT_SESSION_ID, '')
    const paths = data.sessionEntries.map((entry) => entry.path)

    for (const internal of ['presets', 'skills', 'sessions', 'cache']) {
      const dirPath = join('.profer', internal)
      expect(paths.some((path) => path === dirPath || path.startsWith(dirPath + sep))).toBe(false)
    }
    expect(paths).toContain(join('.profer', 'profile.md'))
    expect(paths).toContain(join('.profer', 'memory'))
    expect(paths).toContain(join('.profer', 'memory', 'note.md'))
    expect(paths).toContain(join('.profer', 'workspace-files'))

    // query 直接命中内部目录名也不返回
    const hits = await search(PROJECT_SESSION_ID, 'presets')
    expect(hits.sessionEntries.some((entry) => entry.path.includes('presets'))).toBe(false)
  })
})

describe('project：远程读取授权根 = 项目根 ∪ storageDir ∪ workspace-files', () => {
  test('Given project 会话 When 绝对路径读项目文件 Then 成功', async () => {
    const target = join(projectRoot, 'src', 'app.ts')
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'read_file_as_data_url', sessionId: PROJECT_SESSION_ID, filePath: target }),
      1,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { resolvedPath: string; dataUrl: string }
    expect(data.resolvedPath).toBe(target)
    expect(data.dataUrl.startsWith('data:')).toBe(true)
  })

  test('Given project 会话 When 相对路径读项目文件 Then 以项目根为基准解析', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'resolve_and_read_file', sessionId: PROJECT_SESSION_ID, filePath: join('src', 'nested', 'deep.ts') }),
      1,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { resolvedPath: string }
    // macOS 的 tmpdir 在 /var 下，rootPath 已经 realpath 归一化
    expect(data.resolvedPath).toBe(join(projectRoot, 'src', 'nested', 'deep.ts'))
  })

  test('Given project 会话 When 读 storageDir 附件 / workspace-files Then 均成功', async () => {
    for (const target of [
      join(projectStorageDir, 'note-attachment.md'),
      join(projectRoot, '.profer', 'workspace-files', 'docs', 'guide.md'),
    ]) {
      const result = await handleRemoteCommand(
        JSON.stringify({ type: 'resolve_and_read_file', sessionId: PROJECT_SESSION_ID, filePath: target }),
        1,
      )
      expect(result.ok).toBe(true)
    }
  })

  test('Given project 会话 When 读项目外文件 / 其他工作区 / .. 越界 Then 一律拒绝', async () => {
    const attempts = [
      outsideFile,
      otherWorkspaceFile,
      join(projectRoot, '..', 'outside-secret.ts'),
      '../../outside-secret.ts',
      // 中央 runtimeDir 的兄弟会话目录也不得放开（只授权本会话 storageDir）
      join(workspacesDir, PROJECT_SLUG, 'sessions', 'other-session', 'leak.md'),
    ]

    for (const filePath of attempts) {
      const result = await handleRemoteCommand(
        JSON.stringify({ type: 'resolve_and_read_file', sessionId: PROJECT_SESSION_ID, filePath }),
        1,
      )
      expect(result).toEqual({ ok: false, error: '文件不存在或不在当前会话授权范围内' })
    }
  })
})

describe('managed：roots 与条目逐字不变', () => {
  test('Given managed 会话 When 空 query Then 条目集合与相对/绝对路径口径与改造前一致', async () => {
    const data = await search(MANAGED_SESSION_ID, '')

    // 会话组：sessionRoot 仍是 storageDir（相对路径），不因 rootPath 存在而改变
    expect(data.sessionEntries).toEqual([
      { name: 'managed.ts', path: 'managed.ts', type: 'file', source: 'session' },
    ])
    // 工作区组：工作文件目录为根条目 + 其下文件（绝对路径）
    expect(data.workspaceEntries).toEqual([
      { name: '工作文件', path: managedFilesDir, type: 'dir', source: 'workspace' },
      { name: 'docs', path: join(managedFilesDir, 'docs'), type: 'dir', source: 'workspace' },
      { name: 'm.md', path: join(managedFilesDir, 'docs', 'm.md'), type: 'file', source: 'workspace' },
    ])
    expect(data.total).toBe(4)
  })

  test('Given managed 会话 When 读会话目录文件 Then 仍成功（configDir 授权不变）', async () => {
    for (const target of [
      join(managedStorageDir, 'managed.ts'),
      join(managedFilesDir, 'docs', 'm.md'),
    ]) {
      const result = await handleRemoteCommand(
        JSON.stringify({ type: 'read_file_as_data_url', sessionId: MANAGED_SESSION_ID, filePath: target }),
        1,
      )
      expect(result.ok).toBe(true)
    }
  })
})
