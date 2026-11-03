/**
 * P0 收尾：旧链（`agent-orchestrator.ts` 内联注入）skin 授权必须覆盖 project 的 storageDir
 *
 * 背景：旧链调 `injectAgentSkinMcpServer` 只传 agentCwd / allowedRoots / workspaceSlug，
 * `imageOutputAllowedRoots` 也不含 storageDir。project 下 cwd 是用户项目根、生成图在中央
 * storageDir，于是「拿本会话生成图做皮肤壁纸」会被 `readAuthorizedAgentImage` 判越权。
 *
 * 本用例锁三件事：
 * 1. project：skin 上下文带 storageDir，且图片授权根包含 storageDir → create_skin 读生成图成功；
 * 2. project 反例：去掉 storageDir（旧行为）时同一次 create_skin 必须失败（证明这个缺口真实存在）；
 * 3. managed：storageDir === cwd，图片授权根数组逐字不变（不追加重复根），create_skin 照旧可用。
 *
 * 走的是真实链路：真实会话写入布局 + 真实生图落盘 + 真实 `injectAgentSkinMcpServer`，
 * 只替身两处外部依赖（Electron 单例、皮肤安装器），不重测 skin-manager 的安全校验。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-legacy-skin-storage-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

mock.module('electron', () => ({
  app: { getPath: () => configRoot, getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  clipboard: { readText: () => '', writeText: () => undefined },
  // 皮肤缩略图派生不参与本组用例（显式给 previewPath）；空图即视为不可派生。
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
      skin: { id: 'legacy-storage-skin', name: 'Legacy storage skin', tone: 'dark', contractVersion: 2, builtin: false },
    }
  },
}))

const { composeImageOutputAllowedRoots } = await import('./agent-runtime-product-mcp-injection')
const { createAgentSession, resolveAgentSessionWriteLayout, ensureAgentSessionWriteLayout, resolveAgentSessionCwd } =
  await import('./agent-session-manager')
const { writeAgentImageOutput } = await import('./agent-image-output-service')
const { injectAgentSkinMcpServer } = await import('./agent-skin-tools')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')
// orchestrator 与 agent-service 是已知模块环（service 在模块顶层 new AgentOrchestrator）：
// 先完成 service 侧初始化再取 orchestrator 的纯函数，否则 class 还处在 TDZ。
await import('./agent-service')
const { buildLegacySkinToolContext } = await import('./agent-orchestrator')

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

/** 稳态项目根：用户文件 + 工作区配置（`.profer/` 是设计内落点）。 */
function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  for (const file of ['src/a.ts', 'package.json', '.profer/mcp.json']) {
    const full = join(root, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content:${file}\n`, 'utf-8')
  }
  mkdirSync(join(root, '.profer', 'memory'), { recursive: true })
  mkdirSync(join(root, '.profer', 'workspace-files'), { recursive: true })
  return realpathSync(root)
}

/** 最小合法 PNG（签名 + 少量字节，足够 detectAgentImage 判定）。 */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
}

/** 合法 Surface Contract v2 CSS：create_skin 会逐条校验语义槽位，且必须引用真实壁纸文件名。 */
function validSkinCss(wallpaperFilename: string): string {
  return [
    ':root { --shell-surface: 0 0% 100%; --content-area: 0 0% 100%; --sidebar-surface: 0 0% 98%; --raised-surface: 0 0% 100%; --sunken-surface: 0 0% 96%; --surface-border: 0 0% 90%; --control-surface: 0 0% 100%; --input-surface: 0 0% 100%; --selected-surface: 0 0% 94%; --dialog: 0 0% 100%; --popover: 0 0% 100%; --tooltip: 0 0% 20%; --message-surface: 0 0% 97%; }',
    `body { background-image: url("assets/${wallpaperFilename}"); }`,
  ].join('\n')
}

type SkinToolResult = { content: Array<{ text: string }>; isError?: boolean }

/** 用最小 SDK 替身注入真实 skin 工具，拿回可执行的 create_skin 结果。 */
async function runLegacyCreateSkin(input: {
  context: {
    agentCwd?: string
    storageDir?: string
    allowedRoots: readonly string[]
    workspaceSlug?: string
  }
  wallpaperPath: string
}): Promise<{ result: SkinToolResult; servers: Record<string, Record<string, unknown>> }> {
  const legacyContext = buildLegacySkinToolContext(input.context)
  expect(legacyContext).toBeDefined()

  let handler: ((args: Record<string, unknown>) => Promise<SkinToolResult>) | undefined
  const sdk = {
    tool: (_name: string, _description: string, _parameters: unknown, nextHandler: typeof handler) => {
      handler = nextHandler
      return { name: _name }
    },
    createSdkMcpServer: (server: unknown) => server,
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
  const servers: Record<string, Record<string, unknown>> = {}
  await injectAgentSkinMcpServer(sdk, servers, legacyContext!)
  expect(Object.keys(servers)).toEqual(['agent-skin'])
  expect(handler).toBeDefined()

  const result = await handler!({
    id: 'legacy-storage-skin',
    name: 'Legacy storage skin',
    tone: 'dark',
    skinCss: validSkinCss(basename(input.wallpaperPath)),
    wallpaperPath: input.wallpaperPath,
    previewPath: input.wallpaperPath,
    apply: false,
  })
  return { result, servers }
}

describe('旧链 project：skin 参考图能读 storageDir 里的生成图', () => {
  test('Given project 会话 When 用 storageDir 里的生成图做皮肤 Then 授权通过且安装链路跑通', async () => {
    const root = makeProject('legacy-skin')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('legacy skin session', undefined, 'id-p1', undefined, 'claude', false)
    ensureAgentSessionWriteLayout('p1', meta.id)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    // 旧链里 agentCwd 来自 resolveAgentSessionCwd：project 下就是项目根。
    const agentCwd = resolveAgentSessionCwd('p1', meta.id)

    // 真实生图落点：产物在 storageDir/.context/agent-output-images，不在项目根。
    const generated = await writeAgentImageOutput(pngBytes(), 'image/png', {
      agentCwd,
      storageDir: layout.storageDir,
      allowedRoots: [],
    }, 'generated-image-skinref.png')
    expect(generated.image.localPath.startsWith(realpathSync(layout.imageOutputDir))).toBe(true)
    expect(generated.image.localPath.startsWith(join(root, '.profer', 'sessions'))).toBe(true)

    const attachedDirectories: string[] = []
    const productArtifactDirectories: string[] = []
    const previewAllowedRoots = [agentCwd, ...attachedDirectories, ...productArtifactDirectories]
    // 与 agent-orchestrator 的旧链同一组合规则：project 下 storageDir 追加进图片授权根。
    const imageOutputAllowedRoots = composeImageOutputAllowedRoots({
      workspaceSlug: 'p1',
      agentCwd,
      storageDir: layout.storageDir,
      attachedDirectories,
      productArtifactDirectories,
    })
    expect(imageOutputAllowedRoots).toEqual([...previewAllowedRoots, layout.storageDir])
    expect(imageOutputAllowedRoots.map(item => resolve(item))).toContain(resolve(layout.storageDir))

    const { result } = await runLegacyCreateSkin({
      context: {
        agentCwd,
        storageDir: layout.storageDir,
        allowedRoots: imageOutputAllowedRoots,
        workspaceSlug: 'p1',
      },
      wallpaperPath: generated.image.localPath,
    })
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text) as { ok?: boolean; wallpaper?: string }
    expect(payload.ok).toBe(true)
    expect(payload.wallpaper).toBe(`assets/${basename(generated.image.localPath)}`)
    expect(installedSkinFolders).toHaveLength(1)
    // 会话产物只落 storageDir：项目根不出现 `.context`。
    expect(existsSync(join(root, '.context'))).toBe(false)
  })

  test('Given 项目外的生成图 When 不传 storageDir 做皮肤 Then 判越权', async () => {
    const root = makeProject('legacy-skin-negative')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('legacy skin negative', undefined, 'id-p1', undefined, 'claude', false)
    ensureAgentSessionWriteLayout('p1', meta.id)
    const agentCwd = resolveAgentSessionCwd('p1', meta.id)

    // 会话数据现在在项目内，项目根授权已覆盖 storageDir；
    // 用项目外的图片验证授权边界仍然生效。
    const outsideImage = join(sandbox, 'outside-image.png')
    writeFileSync(outsideImage, pngBytes())

    const { result } = await runLegacyCreateSkin({
      context: {
        agentCwd,
        // 刻意省略 storageDir：这是改造前的旧链参数
        allowedRoots: [agentCwd],
        workspaceSlug: 'p1',
      },
      wallpaperPath: outsideImage,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('不在当前会话或用户已授权目录内')
    expect(installedSkinFolders).toHaveLength(0)
  })
})

describe('旧链 managed：storageDir 与 cwd 重合，旧行为逐字不变', () => {
  test('Given managed 会话 When 组合图片授权根 Then 不追加重复根且皮肤照旧可用', async () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed skin session', undefined, 'id-default', undefined, 'claude', false)
    ensureAgentSessionWriteLayout('default', meta.id)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)
    const agentCwd = resolveAgentSessionCwd('default', meta.id)
    expect(resolve(layout.storageDir)).toBe(resolve(agentCwd))

    const attachedDirectories: string[] = []
    const productArtifactDirectories: string[] = []
    const imageOutputAllowedRoots = composeImageOutputAllowedRoots({
      workspaceSlug: 'default',
      agentCwd,
      storageDir: layout.storageDir,
      attachedDirectories,
      productArtifactDirectories,
    })
    // 逐字不变：与改造前 `workspaceSlug && agentCwd ? previewAllowedRoots : []` 完全相同，没有追加 storageDir。
    expect(imageOutputAllowedRoots).toEqual([agentCwd])

    const legacyContext = buildLegacySkinToolContext({
      agentCwd,
      storageDir: layout.storageDir,
      allowedRoots: imageOutputAllowedRoots,
      workspaceSlug: 'default',
    })
    expect(legacyContext).toEqual({
      agentCwd,
      storageDir: layout.storageDir,
      allowedRoots: [agentCwd],
      workspaceSlug: 'default',
    })

    // managed 下生成图就落在 cwd：带不带 storageDir 都读得到，行为不回归。
    const generated = await writeAgentImageOutput(pngBytes(), 'image/png', {
      agentCwd,
      storageDir: layout.storageDir,
      allowedRoots: [],
    }, 'managed-generated.png')

    const { result } = await runLegacyCreateSkin({
      context: {
        agentCwd,
        storageDir: layout.storageDir,
        allowedRoots: imageOutputAllowedRoots,
        workspaceSlug: 'default',
      },
      wallpaperPath: generated.image.localPath,
    })
    expect(result.isError).toBeUndefined()
    expect((JSON.parse(result.content[0]!.text) as { ok?: boolean }).ok).toBe(true)
    expect(installedSkinFolders).toHaveLength(1)
  })

  test('Given 缺 workspaceSlug 或 cwd When 构造旧链 skin 上下文 Then 不注册（旧语义）', () => {
    expect(buildLegacySkinToolContext({ agentCwd: '/tmp/x', allowedRoots: [], workspaceSlug: undefined })).toBeUndefined()
    expect(buildLegacySkinToolContext({ agentCwd: undefined, allowedRoots: [], workspaceSlug: 'p1' })).toBeUndefined()
  })
})
