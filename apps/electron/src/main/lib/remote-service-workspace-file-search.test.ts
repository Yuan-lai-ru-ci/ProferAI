import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace, FileIndexEntry, FileSearchResult } from '@profer/shared'
import * as actualAgentSessionManager from './agent-session-manager'
import * as actualAgentWorkspaceManager from './agent-workspace-manager'
import * as actualConfigPaths from './config-paths'

/**
 * `search_workspace_files` 的**成功路径**（WS 命令级）。
 *
 * 缺口来源：`quality-report-server.md` §7.2 条目 3 —— 此前只有错误分支被覆盖，
 * 「会话存在 → 服务端推导 roots → 真实扫描 → 返回条目」这条主链路无测试。
 *
 * 测试策略：保留 `searchRemoteWorkspaceFiles` 的真实实现与**真实临时目录文件树**，
 * 只替换三个单测无法构造的数据边界（会话索引 / 工作区索引 / 配置目录路径），
 * 断言的是「真实扫描出来的条目 + 服务端实际使用的 roots」这一可观察行为。
 */
const SESSION_ID = '__profer_test_search_session__'
const WORKSPACE_ID = '__profer_test_search_workspace__'
const WORKSPACE_SLUG = '__profer-test-search-slug'

let root = ''
let sessionRoot = ''
let workspaceRoot = ''
let sessionAttachedDir = ''
let workspaceAttachedDir = ''
let decoyDir = ''
/** 记录工作区级附加目录推导时实际传入的 slug，用于验证 slug 透传。 */
const requestedWorkspaceSlugs: string[] = []
/** 记录会话路径推导时实际传入的 (slug, sessionId)。 */
const requestedSessionPathArgs: Array<{ slug: string; sessionId: string }> = []

function write(path: string, content = 'x'): void {
  writeFileSync(path, content)
}

const fakeSessionMeta = (id: string): AgentSessionMeta | undefined => {
  if (id !== SESSION_ID) return undefined
  return {
    id: SESSION_ID,
    title: '搜索成功路径测试会话',
    workspaceId: WORKSPACE_ID,
    channelId: 'test-channel',
    modelId: 'test-model',
    agentRuntime: 'pi',
    permissionMode: 'auto',
    createdAt: 0,
    updatedAt: 0,
    attachedDirectories: [sessionAttachedDir],
    attachedFiles: [],
  }
}

const fakeWorkspace = (id: string): AgentWorkspace | undefined => {
  if (id !== WORKSPACE_ID) return undefined
  return {
    id: WORKSPACE_ID,
    name: '搜索测试工作区',
    slug: WORKSPACE_SLUG,
    createdAt: 0,
    updatedAt: 0,
  }
}

// `./remote-service` 在文件内首次动态导入时才解析这些依赖，因此 mock 必须在此之前注册。
mock.module('./agent-session-manager', () => ({
  ...actualAgentSessionManager,
  getAgentSessionMeta: fakeSessionMeta,
}))

mock.module('./agent-workspace-manager', () => ({
  ...actualAgentWorkspaceManager,
  getAgentWorkspace: fakeWorkspace,
  getWorkspaceAttachedDirectories: (slug: string) => {
    requestedWorkspaceSlugs.push(slug)
    return slug === WORKSPACE_SLUG ? [workspaceAttachedDir] : []
  },
  getWorkspaceAttachedFiles: () => [],
}))

// 把两个「授权根推导」入口指向真实临时目录，避免触碰用户真实配置目录。
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getAgentSessionWorkspacePath: (slug: string, sessionId: string) => {
    requestedSessionPathArgs.push({ slug, sessionId })
    return slug === WORKSPACE_SLUG && sessionId === SESSION_ID ? sessionRoot : join(root, 'unexpected-session-root')
  },
  getWorkspaceFilesDir: (slug: string) => (slug === WORKSPACE_SLUG ? workspaceRoot : join(root, 'unexpected-workspace-root')),
}))

let handleRemoteCommand: typeof import('./remote-service')['handleRemoteCommand']

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-remote-ws-search-'))
  sessionRoot = join(root, 'session-workbench')
  workspaceRoot = join(root, 'workspace-files')
  sessionAttachedDir = join(root, 'session-attached')
  workspaceAttachedDir = join(root, 'workspace-attached')
  decoyDir = join(root, 'client-supplied-decoy')

  mkdirSync(join(sessionRoot, 'src'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'docs'), { recursive: true })
  mkdirSync(sessionAttachedDir, { recursive: true })
  mkdirSync(workspaceAttachedDir, { recursive: true })
  mkdirSync(decoyDir, { recursive: true })

  write(join(sessionRoot, 'index.ts'))
  write(join(sessionRoot, 'src', 'app.ts'))
  write(join(sessionRoot, 'README.md'))
  write(join(workspaceRoot, 'docs', 'guide.md'))
  write(join(sessionAttachedDir, 'session-notes.md'))
  write(join(workspaceAttachedDir, 'workspace-notes.md'))
  // 客户端在命令里提交的 rootPath / candidateBasePaths 一律不参与授权：
  // 这个诱饵目录中的文件绝不允许出现在结果里。
  write(join(decoyDir, 'decoy-secret.ts'))

  ;({ handleRemoteCommand } = await import('./remote-service'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function searchData(result: Awaited<ReturnType<typeof handleRemoteCommand>>): FileSearchResult {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`预期成功，实际失败：${result.error}`)
  return result.data as FileSearchResult
}

describe('search_workspace_files 成功路径（会话存在）', () => {
  test('会话存在时按服务端推导的 roots 真实扫描，客户端提交的 rootPath 被忽略', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({
        type: 'search_workspace_files',
        sessionId: SESSION_ID,
        query: '',
        // 客户端诱饵：服务端必须完全忽略这两个字段
        rootPath: decoyDir,
        candidateBasePaths: [decoyDir],
      }),
      1,
    )
    const data = searchData(result)

    // 会话组：条目为**相对路径**，只有 sessionRoot 确实来自 getAgentSessionWorkspacePath 才可能如此
    const sessionPaths = data.sessionEntries.map((entry) => entry.path)
    expect(sessionPaths).toContain('index.ts')
    expect(sessionPaths).toContain('README.md')
    expect(sessionPaths).toContain(join('src', 'app.ts'))
    expect(data.sessionEntries.every((entry) => entry.source === 'session')).toBe(true)

    // 工作区组：工作区文件目录以「工作文件」为根条目，绝对路径
    const workspacePaths = data.workspaceEntries.map((entry) => entry.path)
    expect(data.workspaceEntries[0]).toMatchObject({
      name: '工作文件',
      path: workspaceRoot,
      type: 'dir',
      source: 'workspace',
    })
    expect(workspacePaths).toContain(join(workspaceRoot, 'docs', 'guide.md'))
    expect(data.workspaceEntries.every((entry) => entry.source === 'workspace')).toBe(true)

    // roots 推导的实际入参（服务端自行推导，不接受客户端 roots）
    expect(requestedSessionPathArgs).toContainEqual({ slug: WORKSPACE_SLUG, sessionId: SESSION_ID })
    expect(requestedWorkspaceSlugs).toContain(WORKSPACE_SLUG)

    // 客户端提交的装饵目录内容不得泄露
    const allPaths = (data.entries as FileIndexEntry[]).map((entry) => entry.path)
    expect(allPaths.some((path) => path.includes('decoy-secret.ts'))).toBe(false)
    expect(allPaths.some((path) => path.includes(decoyDir))).toBe(false)

    expect(data.total).toBeGreaterThan(0)
    expect(data.entries.length).toBe(data.sessionEntries.length + data.workspaceEntries.length)
  })

  test('会话/工作区附加路径参与 roots 推导，命中条目按所属分组返回', async () => {
    requestedWorkspaceSlugs.length = 0
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'search_workspace_files', sessionId: SESSION_ID, query: 'notes' }),
      2,
    )
    const data = searchData(result)

    // 会话级附加目录（来自 session meta）→ session 组，绝对路径
    const sessionNotes = data.sessionEntries.find((entry) => entry.name === 'session-notes.md')
    expect(sessionNotes).toBeDefined()
    expect(sessionNotes?.path).toBe(join(sessionAttachedDir, 'session-notes.md'))
    expect(sessionNotes?.type).toBe('file')
    expect(sessionNotes?.source).toBe('session')

    // 工作区级附加目录 → workspace 组，且 slug 由会话 meta 推导后透传
    const workspaceNotes = data.workspaceEntries.find((entry) => entry.name === 'workspace-notes.md')
    expect(workspaceNotes).toBeDefined()
    expect(workspaceNotes?.path).toBe(join(workspaceAttachedDir, 'workspace-notes.md'))
    expect(workspaceNotes?.source).toBe('workspace')
    expect(requestedWorkspaceSlugs).toContain(WORKSPACE_SLUG)

    expect(data.total).toBeGreaterThanOrEqual(2)
  })
})
