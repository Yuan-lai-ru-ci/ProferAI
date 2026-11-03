/**
 * P1-8：project 下 `<storageDir>/.claude/settings.json` 对 Claude SDK 惰性
 *
 * 事实链：
 * - SDK 只从 **cwd** 下的 `.claude/settings.json` 读项目设置（`settingSources: ['project']`）；
 * - project 模式 cwd = 用户项目根，而 Profer 那份设置写在中央 storageDir；
 * - 所以 `plansDirectory` / `autoMemoryDirectory` / `skipWebFetchPreflight` 必须由宿主
 *   以 `ClaudeAgentQueryOptions.settings`（SDK flag settings 层）内联下发才真正生效。
 *
 * 本文件锁定三件事：
 * 1. `buildClaudeInlineSdkSettings`（从 `agent-claude-inline-sdk-settings.ts` 真实源码切片编译）在 project 下产出
 *    与 `<storageDir>/.claude/settings.json` **内容一致**的内联对象；
 * 2. 该 `plansDirectory` 按 SDK 语义「相对项目根」解析后正好等于 `storageDir/.context`
 *    （计划文件落 `<storageDir>/.context/plan`，不是项目根的 `.context/plan`）；
 * 3. managed 不产出内联对象（设置文件就在 cwd，保持改造前的读取路径）。
 *
 * 边界说明：这里验证的是「宿主交给 provider 的对象」，**不**证明 SDK 真的读到了（无实机 E2E）；
 * adapter 侧「把 settings 放进 sdkOptions」由 `packages/agent-provider-claude` 的单测覆盖。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
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

// 全路径先 realpath：macOS 上 /var → /private/var，否则 `relative(rootPath, storageDir)` 会算出假相对路径。
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'profer-claude-inline-settings-')))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { createAgentSession, resolveAgentSessionCwd, resolveAgentSessionWriteLayout } = await import('./agent-session-manager')
const { ensureAgentSessionSdkSettings } = await import('./agent-orchestrator-p0-guards')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

/**
 * 从 `agent-claude-inline-sdk-settings.ts` 切片编译纯构造器。
 *
 * 为什么不直接 import `agent-orchestrator.ts`：它与 `agent-service.ts` 存在加载期循环
 * （service 在模块顶层 `new AgentOrchestrator(...)`），直接 import 会在 bun test 里抛
 * ReferenceError。
 * 构造器已抽到独立模块（旧编排链与 runtime provider preparation 共用）；这里改为从该模块切片，
 * 验证的仍是生产源码本身，并让切片标记失效时立刻报错（不静默变成空串）。
 */
const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf8')
const builderModuleSource = readFileSync(new URL('./agent-claude-inline-sdk-settings.ts', import.meta.url), 'utf8')
const sliceStartMarker = 'export function buildClaudeInlineSdkSettings('
const sliceEndMarker = '\n}\n'
const sliceStart = builderModuleSource.indexOf(sliceStartMarker)
const sliceEnd = builderModuleSource.indexOf(sliceEndMarker, sliceStart + sliceStartMarker.length)
if (sliceStart < 0 || sliceEnd <= sliceStart) {
  throw new Error(`agent-claude-inline-sdk-settings.ts 切片标记已失效：${sliceStartMarker}`)
}
const builderSource = builderModuleSource
  .slice(sliceStart, sliceEnd + sliceEndMarker.length)
  .replace('export function buildClaudeInlineSdkSettings(', 'function buildClaudeInlineSdkSettings(')
const compiledBuilder = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(builderSource)
type InlineSettings = Record<string, unknown> | undefined
const buildClaudeInlineSdkSettings = new Function(
  `${compiledBuilder}\nreturn buildClaudeInlineSdkSettings`,
)() as (input: { projectMode: boolean; plansDirectory?: string; autoMemoryDirectory?: string }) => InlineSettings

const workspacesIndexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')
const workspacesDir = join(configRoot, 'agent-workspaces')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [workspacesIndexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

interface RawWorkspace {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
  type: string
  storageMode: string
  rootPath?: string
}

function writeWorkspacesIndex(workspaces: RawWorkspace[]): void {
  mkdirSync(dirname(workspacesIndexPath), { recursive: true })
  writeFileSync(workspacesIndexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function managedEntry(slug: string): RawWorkspace {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function projectEntry(slug: string, rootPath: string): RawWorkspace {
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    createdAt: 1,
    updatedAt: 1,
    type: 'personal',
    storageMode: 'project',
    rootPath,
  }
}

/** 建一个已进入稳态的项目根（`.profer/memory` 是工作区创建后的真实状态）。 */
function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  for (const file of ['src/a.ts', 'package.json', '.profer/mcp.json']) {
    const full = join(root, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content:${file}\n`, 'utf-8')
  }
  mkdirSync(join(root, '.profer', 'memory'), { recursive: true })
  return realpathSync(root)
}

describe('project 下 Claude SDK settings 内联透传', () => {
  test('Given project 会话 When 构造内联 settings Then plansDirectory 落到 storageDir/.context 且与文件逐键一致', () => {
    const root = makeProject('inline')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])

    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    expect(layout.storageDir.startsWith(join(root, '.profer', 'sessions'))).toBe(true)
    expect(layout.contextDir.startsWith(join(root, '.profer', 'sessions'))).toBe(true)

    const autoMemoryDirectory = join(root, '.profer', 'memory')
    // orchestrator 9.5 写盘的同一组值（唯一真相源仍是 layout）
    ensureAgentSessionSdkSettings({
      storageDir: layout.storageDir,
      plansDirectory: layout.plansDirectory,
      autoMemoryDirectory,
    })
    const fileSettings = JSON.parse(readFileSync(layout.claudeSettingsPath, 'utf-8')) as Record<string, unknown>

    const inline = buildClaudeInlineSdkSettings({
      projectMode: true,
      plansDirectory: layout.plansDirectory,
      autoMemoryDirectory,
    })

    expect(inline).toBeDefined()
    // 内联对象必须与文件内容一致：否则「文件读者」和「SDK 读者」看到不同计划目录
    expect(inline).toEqual(fileSettings)
    expect(inline!.plansDirectory).toBe(layout.plansDirectory)
    expect(inline!.skipWebFetchPreflight).toBe(true)
    expect(inline!.autoMemoryDirectory).toBe(autoMemoryDirectory)

    // SDK 把 plansDirectory 解释为「相对项目根」：解析结果必须正好是 storageDir/.context，
    // 于是计划文件落在 storageDir/.context/plan（不是 <root>/.context/plan）。
    expect(layout.plansDirectory).not.toBeUndefined()
    expect(resolve(root, layout.plansDirectory as string)).toBe(layout.contextDir)
    expect(layout.plansDir).toBe(join(layout.contextDir, 'plan'))
  })

  test('Given 无合法相对路径（跨盘符） When 构造内联 settings Then 整条键缺失而不是 undefined', () => {
    const inline = buildClaudeInlineSdkSettings({ projectMode: true, plansDirectory: undefined, autoMemoryDirectory: undefined })

    expect(inline).toEqual({ skipWebFetchPreflight: true })
    expect('plansDirectory' in inline!).toBe(false)
    expect('autoMemoryDirectory' in inline!).toBe(false)
  })

  test('Given managed 会话 When 构造内联 settings Then 不内联（设置文件在 cwd 下，SDK 自己读）', () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)
    const cwd = resolveAgentSessionCwd('default', meta.id)

    // managed：storageDir === cwd，`.claude/settings.json` 就在 SDK 的读取范围里
    expect(layout.storageDir).toBe(cwd)
    expect(layout.plansDirectory).toBe('.context')
    expect(layout.claudeSettingsPath).toBe(join(cwd, '.claude', 'settings.json'))

    expect(buildClaudeInlineSdkSettings({
      projectMode: false,
      plansDirectory: layout.plansDirectory,
      autoMemoryDirectory: join(sandbox, 'memory'),
    })).toBeUndefined()
  })
})

describe('orchestrator 把内联 settings 交给 Claude provider（源码守卫）', () => {
  test('Given 构造好的内联对象 When 组装 queryOptions Then 仅 claude 分支带 settings 字段', () => {
    // 源码守卫：没有实机 E2E 时，至少防止这行被静默删掉而测试仍全绿。
    expect(orchestratorSource).toContain('...(agentRuntime === \'claude\' && claudeInlineSdkSettings && { settings: claudeInlineSdkSettings }),')
    expect(orchestratorSource).toContain('claudeInlineSdkSettings = buildClaudeInlineSdkSettings({')
    expect(orchestratorSource).toContain("projectMode: workspace?.storageMode === 'project',")
  })
})
