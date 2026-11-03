/**
 * P0-A3-3d：新 runtime 链补 `storageDir`
 *
 * 锁住 A3-3c 遗留的四处「新链只拿到 cwd」的写入点：
 * 1. `agent-runtime-entry.ts` 计划模式白名单：project 下计划文件必须落 `storageDir/.context/plan`，
 *    项目根的 `.context/plan` 必须被拒；
 * 2. `agent-runtime-product-mcp-injection.ts` 生图上下文：`agent-gpt-image` / `agent-image-output`
 *    必须拿到 `storageDir`（产物 + jsonl 记录都不进项目根）；
 * 3. `agent-runtime-host.ts` 的 `image-output-roots`：授权根必须包含 `storageDir`，并投影给 Pi 装配 context；
 * 4. `agent-skin-tools.ts` 参考图授权：`create_skin` 必须能读 `storageDir` 里的本会话生成图。
 *
 * 验收方式：
 * - project 下跑「一轮」后项目根目录树逐字不变（`.context` / `.claude` / 生成图 / 记录都不出现）；
 * - managed 下 `storageDir === cwd`，能力根数组与计划白名单与改造前一致（旧行为零变化）。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-runtime-storage-dir-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

mock.module('electron', () => ({
  app: { getPath: () => configRoot, getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  // 皮肤缩略图派生在本组用例里不参与（显式给 previewPath），空图即视为不可派生。
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

/** 皮肤安装链替身：本组只验证「参考图能不能被读到」，不重测 skin-manager 的安全校验。 */
const installedSkinFolders: string[] = []
mock.module('./skin-manager-service', () => ({
  installSkinFromFolder: (folder: string) => {
    installedSkinFolders.push(folder)
    return {
      ok: true as const,
      status: 'installed',
      skin: { id: 'storage-skin', name: 'Storage skin', tone: 'dark', contractVersion: 2, builtin: false },
    }
  },
}))
// settings-service / titlebar-overlay / skin-service 不 mock：整模块替换会连 `getSettings`
// 等其它消费者的导出一起抹掉。皮肤用例传 `apply: false`，不会真的改用户设置或窗口。

const { createAgentSession, resolveAgentSessionWriteLayout, ensureAgentSessionWriteLayout } = await import('./agent-session-manager')
const { createElectronProductMcpCapabilities, withPiProductToolAssemblyFields } = await import('./agent-runtime-host')
const { buildProductMcpInjectorArgs, productMcpPlanInputFromContext } = await import('./agent-runtime-product-mcp-injection')
const { runRuntimeHeadlessEntry } = await import('./agent-runtime-entry')
const { createPlanModeGatedCanUseTool, getAgentRuntimePlanMode } = await import('./agent-runtime-plan-mode')
const { generateAgentGptImage, __setAgentGptImageProviderForTest } = await import('./agent-gpt-image-service')
const { getAgentImageGenerationRecordsPath } = await import('./agent-image-generation-records')
const { writeAgentImageOutput } = await import('./agent-image-output-service')
const { injectAgentSkinMcpServer } = await import('./agent-skin-tools')
const { agentRuntimePolicyRuns } = await import('./agent-runtime-policy-snapshot')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const workspacesIndexPath = join(configRoot, 'agent-workspaces.json')
const workspacesDir = join(configRoot, 'agent-workspaces')

afterAll(() => {
  __setAgentGptImageProviderForTest(undefined)
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
  installedSkinFolders.length = 0
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

/** 稳态项目根：用户文件 + 工作区配置（`.profer/` 是设计内落点），快照对比只反映会话写入。 */
function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  for (const file of ['src/a.ts', 'package.json', '.profer/mcp.json']) {
    const full = join(root, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content:${file}\n`, 'utf-8')
  }
  // `.profer/memory` 与 `.profer/workspace-files` 是工作区创建后的稳态目录（设计内落点），
  // 预建好，快照才只反映「会话写入」是否越界。
  mkdirSync(join(root, '.profer', 'memory'), { recursive: true })
  mkdirSync(join(root, '.profer', 'workspace-files'), { recursive: true })
  return realpathSync(root)
}

/** 项目根快照：相对路径 + 内容长度，用于断言「一个字节都没动」。 */
function snapshotTree(root: string): string[] {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      const rel = relative(root, full)
      if (item.isDirectory()) {
        entries.push(`${rel}/`)
        walk(full)
      } else {
        entries.push(`${rel}:${readFileSync(full, 'utf-8').length}`)
      }
    }
  }
  walk(root)
  return entries.sort()
}

/** 最小合法 PNG（detectAgentImage 只需要签名）。 */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
}

function planPreset(mode: 'plan' | 'default' = 'plan') {
  return {
    id: 'storage-dir-preset',
    name: '存储根测试预设',
    description: '',
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    permissionMode: mode,
  }
}

/** 走一次真实入口（`runRuntimeHeadlessEntry`），返回计划模式门禁。 */
async function runEntryOnce(options: {
  sessionId: string
  workspaceId: string
  workspaceSlug: string
  cwd: string
}): Promise<ReturnType<typeof createPlanModeGatedCanUseTool>> {
  let gate: ReturnType<typeof createPlanModeGatedCanUseTool> | undefined
  await runRuntimeHeadlessEntry(
    {
      sessionId: options.sessionId,
      userMessage: '给我一份实现计划',
      channelId: 'channel-1',
      workspaceId: options.workspaceId,
      triggeredBy: 'user',
    },
    { onEvent: () => undefined },
    {
      resolveRunContext: () => ({
        runtime: 'claude',
        cwd: options.cwd,
        // 刻意不提供 storageDir：验证入口自己从会话写入布局解析（agent-service 目前也只给 slug）。
        toolAssemblyContext: {
          sessionId: options.sessionId,
          workspaceId: options.workspaceId,
          workspaceSlug: options.workspaceSlug,
          agentCwd: options.cwd,
        },
        policy: {
          preset: planPreset('plan'),
          presetReference: { presetId: 'storage-dir-preset', presetScope: 'user-global' },
        },
      }),
      run: () => {
        const controller = getAgentRuntimePlanMode(options.sessionId)
        if (!controller) throw new Error('入口未注册计划模式控制器')
        gate = createPlanModeGatedCanUseTool({
          controller,
          inner: async (_toolName, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
          requestExitPlanApproval: async () => ({ behavior: 'deny', message: '测试无审批通道' }),
        })
        return {
          sessionId: options.sessionId,
          runtime: 'claude' as const,
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
  agentRuntimePolicyRuns.releaseRun(options.sessionId)
  if (!gate) throw new Error('计划模式门禁未生成')
  return gate
}

describe('新链 project：计划模式写入白名单以 storage 计划目录为准', () => {
  test('Given project 会话 When 计划模式写计划文件 Then storage plansDir 放行、项目根 .context/plan 拒绝', async () => {
    const root = makeProject('plan')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('plan session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    expect(layout.storageDir.startsWith(root)).toBe(false)
    mkdirSync(layout.plansDir, { recursive: true })
    const before = snapshotTree(root)

    const gate = await runEntryOnce({ sessionId: meta.id, workspaceId: 'id-p1', workspaceSlug: 'p1', cwd: root })
    const signal = new AbortController().signal

    const storagePlan = join(layout.plansDir, 'roadmap.md')
    await expect(gate('Write', { file_path: storagePlan }, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    const projectPlan = join(root, '.context', 'plan', 'roadmap.md')
    await expect(gate('Write', { file_path: projectPlan }, { signal })).resolves.toMatchObject({ behavior: 'deny' })

    // 被拒的写入不会产生目录：项目根仍然逐字不变。
    expect(existsSync(join(root, '.context'))).toBe(false)
    expect(snapshotTree(root)).toEqual(before)
  })

  test('Given managed 会话 When 计划模式写计划文件 Then 白名单仍是 cwd/.context/plan（旧行为不变）', async () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)
    mkdirSync(layout.plansDir, { recursive: true })
    const gate = await runEntryOnce({ sessionId: meta.id, workspaceId: 'id-default', workspaceSlug: 'default', cwd: layout.storageDir })
    const signal = new AbortController().signal
    await expect(gate('Write', { file_path: join(layout.plansDir, 'plan.md') }, { signal }))
      .resolves.toMatchObject({ behavior: 'allow' })
  })
})

describe('新链 project：生图产物与记录落 storageDir', () => {
  test('Given project 会话 When 生图一轮 Then 能力根含 storageDir、注入上下文含 storageDir、产物与 jsonl 在 storage、项目根零污染', async () => {
    const root = makeProject('image')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('image session', undefined, 'id-p1', undefined, 'claude', false)
    ensureAgentSessionWriteLayout('p1', meta.id)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    const before = snapshotTree(root)

    const capabilities = await createElectronProductMcpCapabilities({
      events: { emit: () => undefined },
      isGptImageAvailable: () => true,
      isPlanModeActive: () => false,
      isRuntimeRunActive: () => true,
    })({ sessionId: meta.id, workspaceId: 'id-p1', workspaceSlug: 'p1', cwd: root })

    const roots = capabilities['image-output-roots']
    expect(roots).toBeDefined()
    expect(roots!.allowedRoots).toContain(layout.storageDir)
    expect(roots!.allowedRoots).toContain(root)
    expect(roots!.storageDir).toBe(layout.storageDir)

    const context = {
      sessionId: meta.id,
      workspaceId: 'id-p1',
      workspaceSlug: 'p1',
      agentCwd: root,
      triggeredBy: 'user' as const,
    }
    const gptArgs = await buildProductMcpInjectorArgs('agent-gpt-image', {
      context,
      mcpServers: {},
      sdk: {} as never,
      planInput: productMcpPlanInputFromContext(context, 'claude', 'standard', [], false),
      capabilities,
    })
    const gptContext = gptArgs[0] as { agentCwd: string; storageDir?: string; allowedRoots: string[] }
    expect(gptContext.storageDir).toBe(layout.storageDir)
    expect(gptContext.allowedRoots).toContain(layout.storageDir)

    __setAgentGptImageProviderForTest(async () => ({ ok: true, bytes: pngBytes(), mediaType: 'image/png', mode: 'byok' }))
    try {
      const result = await generateAgentGptImage(
        { toolCallId: 'round-trip', prompt: '一只在键盘上睡觉的猫' },
        { ...gptContext, sessionId: meta.id },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('生图失败')
      const imageDir = realpathSync(layout.imageOutputDir)
      expect(result.output.image.localPath.startsWith(imageDir)).toBe(true)
      // 产物不在项目根内（project 的 cwd 是用户仓库）。
      expect(result.output.image.localPath.startsWith(root)).toBe(false)
      expect(result.output.image.relativePath.startsWith('.context/agent-output-images/')).toBe(true)

      const recordsPath = await getAgentImageGenerationRecordsPath(root, layout.storageDir)
      // 记录根按 realpath 归一化（macOS 临时目录 /var → /private/var），比较时同样归一化。
      expect(recordsPath).toBe(join(realpathSync(layout.storageDir), '.context', 'image-generations.jsonl'))
      expect(existsSync(recordsPath)).toBe(true)
      expect(readFileSync(recordsPath, 'utf-8')).toContain('round-trip')
    } finally {
      __setAgentGptImageProviderForTest(undefined)
    }

    // 服务层真的没有往项目根写任何东西：目录树逐字一致。
    expect(snapshotTree(root)).toEqual(before)
    expect(existsSync(join(root, '.context'))).toBe(false)
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })

  test('Given managed 会话 When 求图片输出根 Then 与旧链逐字一致（storageDir === cwd，不重复追加）', async () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed image', undefined, 'id-default', undefined, 'claude', false)
    ensureAgentSessionWriteLayout('default', meta.id)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)
    expect(layout.storageDir).toBe(dirname(layout.contextDir))

    const capabilities = await createElectronProductMcpCapabilities({ isPlanModeActive: () => false })({
      sessionId: meta.id,
      workspaceId: 'id-default',
      workspaceSlug: 'default',
      cwd: layout.storageDir,
    })
    const roots = capabilities['image-output-roots']!
    expect(roots.storageDir).toBe(layout.storageDir)
    expect(roots.allowedRoots.filter(root => resolve(root) === resolve(layout.storageDir))).toHaveLength(1)
  })
})

describe('新链 project：skin 参考图能读 storageDir 里的生成图', () => {
  test('Given 生成图在 storage 输出目录 When create_skin 以它为壁纸 Then 授权通过且安装链路跑通', async () => {
    const root = makeProject('skin')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('skin session', undefined, 'id-p1', undefined, 'claude', false)
    ensureAgentSessionWriteLayout('p1', meta.id)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)

    // 真实的生图落点：产物写到 storageDir/.context/agent-output-images。
    const generated = await writeAgentImageOutput(pngBytes(), 'image/png', {
      agentCwd: root,
      storageDir: layout.storageDir,
      allowedRoots: [],
    }, 'generated-image-skinref.png')
    expect(generated.image.localPath.startsWith(realpathSync(layout.imageOutputDir))).toBe(true)
    expect(generated.image.localPath.startsWith(root)).toBe(false)

    const capabilities = await createElectronProductMcpCapabilities({ isPlanModeActive: () => false })({
      sessionId: meta.id,
      workspaceId: 'id-p1',
      workspaceSlug: 'p1',
      cwd: root,
    })
    const context = {
      sessionId: meta.id,
      workspaceId: 'id-p1',
      workspaceSlug: 'p1',
      agentCwd: root,
      triggeredBy: 'user' as const,
    }
    const skinArgs = await buildProductMcpInjectorArgs('agent-skin', {
      context,
      mcpServers: {},
      sdk: {} as never,
      planInput: productMcpPlanInputFromContext(context, 'claude', 'standard', [], false),
      capabilities,
    })
    const skinContext = skinArgs[0] as { agentCwd: string; storageDir?: string; allowedRoots: string[]; workspaceSlug?: string }
    expect(skinContext.storageDir).toBe(layout.storageDir)

    const wallpaperFilename = basename(generated.image.localPath)
    const skinCss = [
      ':root { --shell-surface: 0 0% 100%; --content-area: 0 0% 100%; --sidebar-surface: 0 0% 98%; --raised-surface: 0 0% 100%; --sunken-surface: 0 0% 96%; --surface-border: 0 0% 90%; --control-surface: 0 0% 100%; --input-surface: 0 0% 100%; --selected-surface: 0 0% 94%; --dialog: 0 0% 100%; --popover: 0 0% 100%; --tooltip: 0 0% 20%; --message-surface: 0 0% 97%; }',
      `body { background-image: url("assets/${wallpaperFilename}"); }`,
    ].join('\n')

    let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) | undefined
    const sdk = {
      tool: (_name: string, _description: string, _parameters: unknown, nextHandler: typeof handler) => {
        handler = nextHandler
        return { name: _name }
      },
      createSdkMcpServer: (server: unknown) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    const servers: Record<string, Record<string, unknown>> = {}
    await injectAgentSkinMcpServer(sdk, servers, skinContext)
    expect(Object.keys(servers)).toEqual(['agent-skin'])
    expect(handler).toBeDefined()

    const result = await handler!({
      id: 'storage-skin',
      name: 'Storage skin',
      tone: 'dark',
      skinCss,
      wallpaperPath: generated.image.localPath,
      previewPath: generated.image.localPath,
      apply: false,
    })
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as { ok?: boolean; wallpaper?: string }
    expect(payload.ok).toBe(true)
    expect(payload.wallpaper).toBe(`assets/${wallpaperFilename}`)
    expect(installedSkinFolders).toHaveLength(1)

    // 安装源是临时 staging 目录；授权读取失败会直接返回 isError，不会走到安装。
    expect(existsSync(join(root, '.context'))).toBe(false)
  })
})

describe('新链 project：Pi 装配 context 拿到 storageDir', () => {
  test('Given project 会话 When 投影产品能力进 Pi 装配 Then storageDir 来自会话写入布局', async () => {
    const root = makeProject('pi')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('pi session', undefined, 'id-p1', undefined, 'pi', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)

    const provider = createElectronProductMcpCapabilities({ isPlanModeActive: () => false })
    const fields = await withPiProductToolAssemblyFields(
      { sessionId: meta.id, workspaceSlug: 'p1', workspaceId: 'id-p1', agentCwd: root },
      provider,
    ) as Record<string, unknown>
    expect(fields.storageDir).toBe(layout.storageDir)
    // 调用方已给出的字段不被覆盖（严格只补缺失键）。
    const kept = await withPiProductToolAssemblyFields(
      { sessionId: meta.id, workspaceSlug: 'p1', agentCwd: root, storageDir: '/explicit/storage' },
      provider,
    ) as Record<string, unknown>
    expect(kept.storageDir).toBe('/explicit/storage')
  })

  test('Given managed 会话 When 投影产品能力 Then storageDir 等于 cwd（旧行为不变）', async () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed pi', undefined, 'id-default', undefined, 'pi', false)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)
    const provider = createElectronProductMcpCapabilities({ isPlanModeActive: () => false })
    const fields = await withPiProductToolAssemblyFields(
      { sessionId: meta.id, workspaceSlug: 'default', workspaceId: 'id-default', agentCwd: layout.storageDir },
      provider,
    ) as Record<string, unknown>
    expect(fields.storageDir).toBe(layout.storageDir)
  })
})
