/**
 * P2：headless / 自动化链补 SDK settings 内联透传（P1-8 的同类修复）。
 *
 * 锁住的行为：
 * 1. project 会话经 runtime 入口（`runRuntimeHeadlessEntry`）构造的 query，在 provider preparation
 *    产出的 Claude options 里必须带 `settings`，且 `plansDirectory` 与会话写入布局同值
 *    （相对项目根解析后 = `<storageDir>/.context`），`skipWebFetchPreflight` / `autoMemoryDirectory` 同磁盘 settings；
 * 2. managed 不传 `settings`（SDK 继续读 cwd 下的 `.claude/settings.json`，行为与改造前逐字一致）；
 * 3. automation 来源（同一入口、`triggeredBy: 'automation'`）同样生效；
 * 4. 只影响 Claude：Pi options 不出现 `settings`；权限模式等既有字段保持不变。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'profer-provider-settings-')))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

mock.module('electron', () => ({
  app: { getPath: () => configRoot, getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
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

const { createAgentSession, resolveAgentSessionWriteLayout } = await import('./agent-session-manager')
const { getWorkspaceAutoMemoryDir } = await import('./agent-workspace-manager')
const { runRuntimeHeadlessEntry } = await import('./agent-runtime-entry')
const { createElectronProviderQueryPreparation } = await import('./agent-runtime-provider-preparation')
const { agentRuntimePolicyRuns } = await import('./agent-runtime-policy-snapshot')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const workspacesIndexPath = join(configRoot, 'agent-workspaces.json')
const workspacesDir = join(configRoot, 'agent-workspaces')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [workspacesIndexPath, join(configRoot, 'agent-sessions.json')]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(workspacesDir, { recursive: true, force: true })
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
  for (const file of ['src/a.ts', 'package.json']) {
    const full = join(root, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content:${file}\n`, 'utf-8')
  }
  // `.profer/memory` 是 project 工作区创建后的稳态落点（AUTO memory 目录），预建好避免用例误判污染。
  mkdirSync(join(root, '.profer', 'memory'), { recursive: true })
  return realpathSync(root)
}

/**
 * 走一次真实 runtime 入口，捕获宿主要交给 provider 的 query。
 *
 * 只替换 `run`（不启动 provider）与端口替身，其余（query 构造、策略挂载、持久化器、终态投影）
 * 都与生产同源，因此随后对 query 调 provider preparation 得到的就是 headless 链真实 provider options。
 */
async function captureHeadlessQuery(input: Record<string, unknown>, options: {
  cwd: string
  workspaceId: string
  workspaceSlug: string
  runtime?: 'claude' | 'pi'
}): Promise<AgentRuntimeQuery> {
  let captured: AgentRuntimeQuery | undefined
  await runRuntimeHeadlessEntry(
    input as never,
    { onEvent: () => undefined },
    {
      resolveRunContext: () => ({
        runtime: options.runtime ?? 'claude',
        cwd: options.cwd,
        toolAssemblyContext: {
          sessionId: input.sessionId,
          workspaceId: options.workspaceId,
          workspaceSlug: options.workspaceSlug,
          agentCwd: options.cwd,
        },
      }),
      run: (query: AgentRuntimeQuery) => {
        captured = query
        return {
          sessionId: query.sessionId,
          runtime: query.runtime,
          promise: Promise.resolve({ status: 'completed' as const }),
          stop: async () => undefined,
        }
      },
      sessions: {
        getMeta: () => undefined,
        appendMessages: () => undefined,
        updateMeta: () => undefined,
        getMessages: () => [],
      },
      messages: () => [],
      emitPlanModeEvent: () => undefined,
      onRunStarted: () => undefined,
      applyCompletionUnread: () => undefined,
      sink: { onError: () => undefined, onComplete: () => undefined },
    } as never,
  )
  agentRuntimePolicyRuns.releaseRun(String(input.sessionId))
  if (!captured) throw new Error('runtime 入口未把 query 交给 run')
  return captured
}

async function prepareProviderOptions(query: AgentRuntimeQuery): Promise<Record<string, unknown>> {
  return await createElectronProviderQueryPreparation().prepare(
    query,
    {
      credentials: { apiKey: 'fixture-key', baseUrl: undefined, provider: 'anthropic', forceBearerAuth: false },
      systemPrompt: 'prepared prompt',
    },
    new AbortController().signal,
  ) as Record<string, unknown>
}

describe('headless 链：project 下 Claude options 内联 SDK settings', () => {
  test('Given project 会话 When headless 一轮准备 provider Then settings 与磁盘 settings 同值且 plansDirectory 落在 storage', async () => {
    const root = makeProject('settings')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('settings session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    expect(layout.storageDir.startsWith(root)).toBe(false)

    const query = await captureHeadlessQuery(
      { sessionId: meta.id, userMessage: '继续', channelId: 'channel-1', workspaceId: 'id-p1', triggeredBy: 'user' },
      { cwd: root, workspaceId: 'id-p1', workspaceSlug: 'p1' },
    )
    const options = await prepareProviderOptions(query)

    const settings = options.settings as { plansDirectory?: string; skipWebFetchPreflight?: boolean; autoMemoryDirectory?: string }
    expect(settings).toEqual({
      plansDirectory: layout.plansDirectory,
      skipWebFetchPreflight: true,
      autoMemoryDirectory: getWorkspaceAutoMemoryDir('p1'),
    })
    // SDK 把 plansDirectory 解释为「相对项目根」：解析后必须等于 storageDir 下的 .context，绝不落项目根。
    expect(resolve(root, settings.plansDirectory!)).toBe(layout.contextDir)
    expect(existsSync(join(root, '.claude'))).toBe(false)
    // 只新增 settings：模型/权限/工具字段保持原样。
    expect(options.cwd).toBe(root)
    expect(options.sdkPermissionMode).toBeUndefined()
  })

  test('Given project 会话带权限覆盖 When headless 准备 provider Then settings 与权限模式同时生效', async () => {
    const root = makeProject('settings-permission')
    writeWorkspacesIndex([projectEntry('p2', root)])
    const meta = createAgentSession('permission session', undefined, 'id-p2', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p2', meta.id)

    const query = await captureHeadlessQuery(
      {
        sessionId: meta.id,
        userMessage: '继续',
        channelId: 'channel-1',
        workspaceId: 'id-p2',
        triggeredBy: 'user',
        permissionModeOverride: 'plan',
      },
      { cwd: root, workspaceId: 'id-p2', workspaceSlug: 'p2' },
    )
    const options = await prepareProviderOptions(query)

    expect((options.settings as { plansDirectory?: string }).plansDirectory).toBe(layout.plansDirectory)
    expect(options.sdkPermissionMode).toBe('plan')
  })

  test('Given managed 会话 When headless 准备 provider Then 不传 settings（SDK 继续读 cwd 下的文件）', async () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)

    const query = await captureHeadlessQuery(
      { sessionId: meta.id, userMessage: '继续', channelId: 'channel-1', workspaceId: 'id-default', triggeredBy: 'user' },
      { cwd: layout.storageDir, workspaceId: 'id-default', workspaceSlug: 'default' },
    )
    const options = await prepareProviderOptions(query)

    expect('settings' in options).toBe(false)
  })

  test('Given automation 来源 When project 下 headless 一轮准备 provider Then settings 同样生效', async () => {
    const root = makeProject('settings-automation')
    writeWorkspacesIndex([projectEntry('p3', root)])
    const meta = createAgentSession('automation session', undefined, 'id-p3', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p3', meta.id)

    const query = await captureHeadlessQuery(
      {
        sessionId: meta.id,
        userMessage: '整理周报',
        channelId: 'channel-1',
        workspaceId: 'id-p3',
        triggeredBy: 'automation',
        automationContext: '<automation id="a-1" name="周报" />',
      },
      { cwd: root, workspaceId: 'id-p3', workspaceSlug: 'p3' },
    )
    const options = await prepareProviderOptions(query)

    expect((options.settings as { plansDirectory?: string }).plansDirectory).toBe(layout.plansDirectory)
    expect(resolve(root, (options.settings as { plansDirectory: string }).plansDirectory)).toBe(layout.contextDir)
  })

  test('Given project 的 Pi 会话 When headless 准备 provider Then 不出现 Claude 专用 settings', async () => {
    const root = makeProject('settings-pi')
    writeWorkspacesIndex([projectEntry('p4', root)])
    const meta = createAgentSession('pi session', undefined, 'id-p4', undefined, 'pi', false)

    const query = await captureHeadlessQuery(
      { sessionId: meta.id, userMessage: '继续', channelId: 'channel-1', workspaceId: 'id-p4', agentRuntime: 'pi', triggeredBy: 'user' },
      { cwd: root, workspaceId: 'id-p4', workspaceSlug: 'p4', runtime: 'pi' },
    )
    const options = await prepareProviderOptions(query)

    expect(query.runtime).toBe('pi')
    expect('settings' in options).toBe(false)
  })

  test('Given query 只带 workspaceId（无装配 context）When project 准备 provider Then 仍按工作区解析 settings', async () => {
    const root = makeProject('settings-workspace-id')
    writeWorkspacesIndex([projectEntry('p5', root)])
    const meta = createAgentSession('workspace id session', undefined, 'id-p5', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p5', meta.id)

    const options = await prepareProviderOptions({
      sessionId: meta.id,
      runtime: 'claude',
      prompt: 'fixture',
      cwd: root,
      workspaceId: 'id-p5',
    })

    expect((options.settings as { plansDirectory?: string }).plansDirectory).toBe(layout.plansDirectory)
  })
})
