/**
 * P1-残留-1：会话所属工作区不存在时，任何运行入口都不得把 `$HOME` 当 cwd 执行。
 *
 * 根因回顾：
 * - `resolveAgentSessionCwd(undefined, sid)` 返回 `homedir()`；
 * - 旧实现只在 `input.workspaceId` 存在时才尝试解析工作区，解析失败静默保留 `homedir()`；
 * - project 工作区「移除项目」只删索引、保留会话历史，于是死会话在 headless 链
 *   （remote / bridge / feishu / 协作 / automation）里仍可被发送，cwd 落到用户主目录。
 *
 * 本文件锁四件事：
 * 1. 工作区存在 → headless cwd 正确（managed 会话目录 / project 项目根各一）；
 * 2. 工作区已删 → `requireAgentRunWorkspace` / runtime 入口 / 旧链 `sendMessage` 全部拒绝，
 *    且 provider `query` / coordinator `run` 零调用；
 * 3. 只有会话元数据带 workspaceId（调用方没带）也必须拒绝 —— 这是 Pocket / IM 的真实形态；
 * 4. Pocket 的 `list_sessions` 不再下发已删除工作区的会话（避免手机向死会话发消息）。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentSendInput } from '@profer/shared'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-run-workspace-guard-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

mock.module('electron', () => ({
  app: { getPath: () => configRoot, getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  clipboard: { readText: () => '', writeText: () => undefined },
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

// orchestrator 与 agent-service 是已知模块环（service 在模块顶层 new AgentOrchestrator）：
// 先完成 service 侧初始化，再取 orchestrator 的导出，避免 class 处在 TDZ。
const { buildRuntimeHeadlessRunContext, runAgentRuntimeHeadless, agentEventBus } = await import('./agent-service')
const {
  AgentOrchestrator,
  AgentSessionWorkspaceMissingError,
  requireAgentRunWorkspace,
} = await import('./agent-orchestrator')
const { runRuntimeHeadlessEntry } = await import('./agent-runtime-entry')
const { createAgentSession, getAgentSessionMeta } = await import('./agent-session-manager')
const { handleRemoteCommand } = await import('./remote-service')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const workspacesIndexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [workspacesIndexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

interface WorkspaceEntry {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
  type: string
  storageMode: string
  rootPath?: string
}

function writeWorkspacesIndex(workspaces: WorkspaceEntry[]): void {
  mkdirSync(dirname(workspacesIndexPath), { recursive: true })
  writeFileSync(workspacesIndexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function managedEntry(slug: string): WorkspaceEntry {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function projectEntry(slug: string, rootPath: string): WorkspaceEntry {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}\n', 'utf-8')
  return realpathSync(root)
}

function sendInput(sessionId: string, workspaceId?: string): AgentSendInput {
  return {
    sessionId,
    userMessage: 'hello',
    channelId: 'channel-fixture',
    modelId: 'model-fixture',
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  }
}

describe('工作区存在：headless cwd 与改造前一致', () => {
  test('managed 工作区 → cwd 是会话目录', () => {
    writeWorkspacesIndex([managedEntry('managed-ws')])
    const meta = createAgentSession('managed session', 'channel-fixture', 'id-managed-ws', 'model-fixture', 'claude')

    const context = buildRuntimeHeadlessRunContext(sendInput(meta.id, 'id-managed-ws'))

    expect(context.cwd).toBe(join(configRoot, 'agent-workspaces', 'managed-ws', meta.id))
    expect(context.toolAssemblyContext.workspaceSlug).toBe('managed-ws')
  })

  test('project 工作区 → cwd 是项目根', () => {
    const root = makeProject('live-project')
    writeWorkspacesIndex([projectEntry('project-ws', root)])
    const meta = createAgentSession('project session', 'channel-fixture', 'id-project-ws', 'model-fixture', 'claude')

    const context = buildRuntimeHeadlessRunContext(sendInput(meta.id, 'id-project-ws'))

    expect(context.cwd).toBe(root)
    expect(context.toolAssemblyContext.workspaceSlug).toBe('project-ws')
  })
})

describe('工作区已删除：拒绝执行，绝不回落 $HOME', () => {
  test('requireAgentRunWorkspace：解析不到抛具名错误；无工作区的历史会话返回 undefined', () => {
    writeWorkspacesIndex([])

    expect(() => requireAgentRunWorkspace({ sessionId: 's1', workspaceId: 'gone' }))
      .toThrow(AgentSessionWorkspaceMissingError)
    expect(() => requireAgentRunWorkspace({ sessionId: 's1', sessionWorkspaceId: 'gone' }))
      .toThrow('会话所属工作区已不存在')
    // 完全没有工作区的历史会话保持既有语义（cwd = homedir），不在本次收紧范围。
    expect(requireAgentRunWorkspace({ sessionId: 's1' })).toBeUndefined()
  })

  test('runtime headless 入口：resolveRunContext 阶段拒绝，coordinator run 零调用', async () => {
    const root = makeProject('dead-project')
    writeWorkspacesIndex([projectEntry('dead-ws', root)])
    const meta = createAgentSession('dead session', 'channel-fixture', 'id-dead-ws', 'model-fixture', 'claude')
    // 模拟「移除项目」：只删索引，保留会话历史。
    writeWorkspacesIndex([])

    let runCalls = 0
    const sinks: string[] = []
    const run = runRuntimeHeadlessEntry(sendInput(meta.id, 'id-dead-ws'), { onEvent: () => {} }, {
      resolveRunContext: buildRuntimeHeadlessRunContext,
      run: () => { runCalls++; throw new Error('provider 不应被调用') },
      sessions: {
        getMeta: getAgentSessionMeta,
        appendMessages: () => {},
        updateMeta: () => {},
        getMessages: () => [],
      },
      messages: () => [],
      emitPlanModeEvent: () => {},
      onRunStarted: () => {},
      applyCompletionUnread: () => {},
      sink: { onError: error => sinks.push(error), onComplete: () => {} },
    })

    await expect(run).rejects.toThrow('会话所属工作区已不存在')
    expect(runCalls).toBe(0)
    // 拒绝发生在 provider 启动之前：入口不伪造任何终态。
    expect(sinks).toEqual([])
  })

  test('runtime headless 入口：调用方没带 workspaceId，但会话属于已删工作区 → 同样拒绝', async () => {
    const root = makeProject('dead-project-meta-only')
    writeWorkspacesIndex([projectEntry('dead-ws-meta', root)])
    const meta = createAgentSession('dead session meta', 'channel-fixture', 'id-dead-ws-meta', 'model-fixture', 'claude')
    writeWorkspacesIndex([])

    let runCalls = 0
    await expect(runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, {
      resolveRunContext: buildRuntimeHeadlessRunContext,
      run: () => { runCalls++; throw new Error('provider 不应被调用') },
      sessions: {
        getMeta: getAgentSessionMeta,
        appendMessages: () => {},
        updateMeta: () => {},
        getMessages: () => [],
      },
      messages: () => [],
      emitPlanModeEvent: () => {},
      onRunStarted: () => {},
      applyCompletionUnread: () => {},
      sink: { onError: () => {}, onComplete: () => {} },
    })).rejects.toThrow(AgentSessionWorkspaceMissingError)
    expect(runCalls).toBe(0)
  })

  test('runtime headless 包装（remote / bridge / feishu / 协作必经）：拒绝时投递可见错误终态', async () => {
    const root = makeProject('dead-project-wrapper')
    writeWorkspacesIndex([projectEntry('dead-ws-wrap', root)])
    const meta = createAgentSession('dead wrapper session', 'channel-fixture', 'id-dead-ws-wrap', 'model-fixture', 'claude')
    writeWorkspacesIndex([])

    const errors: string[] = []
    const completions: Array<{ endReason?: string }> = []
    const emitted: Array<{ kind: string; error?: string; endReason?: string }> = []
    const off = agentEventBus.on((sessionId, payload) => {
      if (sessionId !== meta.id) return
      if (payload.kind === 'run_error') emitted.push({ kind: payload.kind, error: payload.error })
      if (payload.kind === 'run_complete') emitted.push({ kind: payload.kind, endReason: payload.completion.endReason })
    })
    try {
      await runAgentRuntimeHeadless(sendInput(meta.id, 'id-dead-ws-wrap'), {
        source: 'bridge',
        onError: error => errors.push(error),
        onComplete: (_messages, fields) => completions.push({ endReason: fields?.endReason }),
        onTitleUpdated: () => {},
      })
    } finally {
      off()
    }

    // 不抛回调用方（IM / Pocket 的 promise 链不处理拒绝），而是把原因作为可见终态下发。
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('会话所属工作区已不存在')
    expect(completions).toHaveLength(1)
    expect(completions[0]?.endReason).toBe('error')
    // 跨端事件（Pocket / 飞书卡片）也拿到同一个原因。
    expect(emitted).toContainEqual({ kind: 'run_error', error: errors[0] })
    expect(emitted).toContainEqual({ kind: 'run_complete', endReason: 'error' })
  })

  test('旧链 sendMessage：工作区已删 → 抛具名错误、不启动 provider query、不伪造终态', async () => {
    const root = makeProject('dead-project-legacy')
    writeWorkspacesIndex([projectEntry('dead-ws-legacy', root)])
    const meta = createAgentSession('dead legacy session', 'channel-fixture', 'id-dead-ws-legacy', 'model-fixture', 'claude')
    writeWorkspacesIndex([])

    let providerQueryCalls = 0
    const adapter = {
      errorHelpers: {},
      getErrorHelpers: () => undefined,
      query: () => { providerQueryCalls++; throw new Error('provider query 不应被调用') },
    }
    const orchestrator = new AgentOrchestrator(adapter as never, { on() {}, emit() {} } as never)
    const errors: string[] = []
    const completions: unknown[] = []

    await expect(orchestrator.sendMessage(sendInput(meta.id, 'id-dead-ws-legacy'), {
      onError: error => errors.push(error),
      onComplete: (...args: unknown[]) => completions.push(args),
      onTitleUpdated: () => {},
    })).rejects.toThrow(AgentSessionWorkspaceMissingError)

    expect(providerQueryCalls).toBe(0)
    expect(errors).toEqual([])
    expect(completions).toEqual([])
  })
})

describe('Pocket list_sessions：不再下发已删除工作区的会话', () => {
  test('活项目会话与无工作区历史会话保留，死项目会话被过滤', async () => {
    const root = makeProject('live-list-project')
    // 归档工作区：仍然存在于索引，但 Pocket 不展示（既有行为）。
    writeWorkspacesIndex([
      projectEntry('live-ws', root),
      { ...managedEntry('archived-ws'), archived: true } as WorkspaceEntry,
      projectEntry('dead-ws', makeProject('dead-list-project')),
    ])
    const liveSession = createAgentSession('live', 'channel-fixture', 'id-live-ws', 'model-fixture', 'claude')
    const archivedSession = createAgentSession('archived', 'channel-fixture', 'id-archived-ws', 'model-fixture', 'claude')
    const deadSession = createAgentSession('dead', 'channel-fixture', 'id-dead-ws', 'model-fixture', 'claude')
    const standaloneSession = createAgentSession('standalone', 'channel-fixture', undefined, 'model-fixture', 'claude')
    // 模拟「移除项目」：只删索引，保留会话历史；archived 工作区仍保留（用来区分两种过滤）。
    writeWorkspacesIndex([
      projectEntry('live-ws', root),
      { ...managedEntry('archived-ws'), archived: true } as WorkspaceEntry,
    ])

    const result = await handleRemoteCommand(JSON.stringify({ type: 'list_sessions' }), 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = (result.data as Array<{ id: string }>).map(item => item.id)

    expect(ids).toContain(liveSession.id)
    expect(ids).toContain(standaloneSession.id)
    expect(ids).not.toContain(deadSession.id)
    expect(ids).not.toContain(archivedSession.id)
  })
})
