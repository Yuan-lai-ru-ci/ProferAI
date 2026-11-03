/**
 * P0-A3-3c：串行「一轮」写入后 project 根零污染
 *
 * 锁住四条验收：
 * 1. project 下会话准备（SDK settings + 计划目录）与一轮生图（产物 + jsonl）全部落在中央
 *    storageDir，rootPath 目录树与之前逐字一致（不出现 `.claude`、`.context`、
 *    `agent-output-images`、`session-errors.log`）；
 * 2. 计划模式白名单以 storageDir 的 plansDir 为准：storage 计划文件通过，rootPath 的
 *    `.context/plan` 被拒；
 * 3. managed 全部保持原行为（storageDir === cwd，plansDirectory 仍是 `.context`）；
 * 4. SDK settings 准备是幂等的：同一布局重复调用不再改写文件。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-orchestrator-write-isolation-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { createAgentSession, resolveAgentSessionWriteLayout } = await import('./agent-session-manager')
const { ensureAgentSessionSdkSettings, isPlanModeMarkdownPath } = await import('./agent-orchestrator-p0-guards')
const { createPlanModeToolPolicy } = await import('./plan-mode-tool-policy')
const { sendAgentLocalImage, writeAgentImageOutput } = await import('./agent-image-output-service')
const { createImageGenerationRecord, listImageGenerationCards, transitionImageGenerationRecord } =
  await import('./agent-image-generation-records')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

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
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

/**
 * 建一个「已进入稳态」的项目根：用户文件 + 工作区配置（project 模式的 `.profer/` 是设计内落点）。
 * `.profer/memory` 预先建好，模拟工作区创建完成后的真实状态，这样快照对比才只反映会话写入。
 */
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

/** 项目根快照：相对路径 + 文件长度，用于断言「一个字节都没动」。 */
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
  // 会话运行时数据现在位于 `.profer/sessions`，属于工作区资产；这里断言的是「用户项目文件零污染」。
  return entries.filter((entry) => !entry.startsWith('.profer/sessions')).sort()
}

/** 最小合法 PNG（只有签名 + 少量字节，足够 detectAgentImage 判定）。 */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

describe('project：一轮写入后 rootPath 零污染', () => {
  test('Given project 会话 When 准备写入布局 + 生图一轮 Then 项目根目录树与之前完全一致', async () => {
    const root = makeProject('round-trip')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const before = snapshotTree(root)

    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    expect(layout.storageDir.startsWith(join(root, '.profer', 'sessions'))).toBe(true)

    // 1) orchestrator 9.5：SDK settings（含 autoMemoryDirectory）
    const settings = ensureAgentSessionSdkSettings({
      storageDir: layout.storageDir,
      plansDirectory: layout.plansDirectory,
      autoMemoryDirectory: join(root, '.profer', 'memory'),
    })
    expect(settings.settingsPath).toBe(layout.claudeSettingsPath)
    expect(existsSync(layout.claudeSettingsPath)).toBe(true)

    // 2) orchestrator 计划目录准备（storageDir/.context/plan）
    if (!existsSync(layout.plansDir)) mkdirSync(layout.plansDir, { recursive: true })

    // 3) 一轮生图：产物 + 记录
    const output = await writeAgentImageOutput(pngBytes(), 'image/png', {
      agentCwd: root,
      storageDir: layout.storageDir,
      allowedRoots: [],
    })
    // 产物真实落点：macOS 临时目录 realpath 会去掉 /private 前缀，比较时统一用 realpath
    expect(output.image.localPath.startsWith(realpathSync(layout.imageOutputDir))).toBe(true)
    expect(output.image.relativePath).toBe(relative(realpathSync(layout.storageDir), output.image.localPath).split(sep).join('/'))

    const record = await createImageGenerationRecord({
      sessionId: meta.id,
      agentCwd: root,
      storageDir: layout.storageDir,
      toolCallId: 'tool-1',
      prompt: 'blue rocket',
      reference: { kind: 'none' },
    })
    await transitionImageGenerationRecord(
      { sessionId: meta.id, agentCwd: root, storageDir: layout.storageDir },
      record.id,
      { status: 'saving' },
    )
    await transitionImageGenerationRecord(
      { sessionId: meta.id, agentCwd: root, storageDir: layout.storageDir },
      record.id,
      {
        status: 'succeeded',
        image: { localPath: output.image.localPath, filename: output.image.filename, mediaType: 'image/png' },
      },
    )
    expect(existsSync(join(layout.contextDir, 'image-generations.jsonl'))).toBe(true)

    // 4) 生成的图仍可回发（storageDir 必须是合法授权根）
    const sent = await sendAgentLocalImage({ path: output.image.localPath }, {
      agentCwd: root,
      storageDir: layout.storageDir,
      allowedRoots: [],
    })
    expect(sent.image.localPath.startsWith(realpathSync(layout.imageOutputDir))).toBe(true)

    // 5) 记录可回放
    const cards = await listImageGenerationCards({ sessionId: meta.id, agentCwd: root, storageDir: layout.storageDir })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: record.id, status: 'succeeded' })

    // 6) 验收：项目根目录树一个字节都没动
    expect(snapshotTree(root)).toEqual(before)
    for (const artifact of ['.claude', '.context', 'agent-output-images', 'session-errors.log']) {
      expect(existsSync(join(root, artifact))).toBe(false)
    }
    expect(layout.errorsLogPath.startsWith(layout.storageDir)).toBe(true)
  })

  test('Given 同一 project 布局 When 重复准备 SDK settings Then 不再改写文件（每轮无写入）', () => {
    const root = makeProject('settings-idempotent')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    const input = {
      storageDir: layout.storageDir,
      plansDirectory: layout.plansDirectory,
      autoMemoryDirectory: join(root, '.profer', 'memory'),
    }

    ensureAgentSessionSdkSettings(input)
    const snapshot = readSettings(layout.claudeSettingsPath)
    const second = ensureAgentSessionSdkSettings(input)

    expect(second.wrote).toBe(false)
    expect(readSettings(layout.claudeSettingsPath)).toEqual(snapshot)
    // plansDirectory 必须解析回 storageDir，两种 join/resolve 语义都成立
    expect(resolve(root, snapshot.plansDirectory as string)).toBe(layout.contextDir)
  })
})

describe('计划模式：白名单以 storageDir 的 plansDir 为准', () => {
  test('Given project 会话 When 写 storageDir 计划目录 Then 放行；写 rootPath/.context/plan Then 拒绝', () => {
    const root = makeProject('plan-mode')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    const policy = createPlanModeToolPolicy(root, layout.plansDir)

    const allowedPath = join(layout.plansDir, 'p1-plan.md')
    expect(isPlanModeMarkdownPath(root, allowedPath, layout.plansDir)).toBe(true)
    expect(policy({ toolName: 'Write', toolInput: { file_path: allowedPath } })).toEqual({ behavior: 'allow' })
    expect(policy({ toolName: 'Edit', toolInput: { file_path: allowedPath } })).toEqual({ behavior: 'allow' })

    const projectPlanPath = join(root, '.context', 'plan', 'p1-plan.md')
    expect(isPlanModeMarkdownPath(root, projectPlanPath, layout.plansDir)).toBe(false)
    expect(policy({ toolName: 'Write', toolInput: { file_path: projectPlanPath } })).toMatchObject({ behavior: 'deny' })
    expect(policy({ toolName: 'Write', toolInput: { file_path: join(root, 'src', 'a.ts') } })).toMatchObject({ behavior: 'deny' })

    // 缺省 planDir 保持旧语义（cwd/.context/plan），用于未接线调用方
    expect(isPlanModeMarkdownPath(root, '.context/plan/legacy.md')).toBe(true)
    // storageDir 计划目录只接受 .md
    expect(policy({ toolName: 'Write', toolInput: { file_path: join(layout.plansDir, 'notes.txt') } })).toMatchObject({ behavior: 'deny' })
  })

  test('Given managed 会话 When 计划模式写入 Then 仍是 cwd/.context/plan 且计划落点不在项目根', () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)
    expect(layout.plansDirectory).toBe('.context')

    const policy = createPlanModeToolPolicy(layout.storageDir, layout.plansDir)
    expect(policy({ toolName: 'Write', toolInput: { file_path: '.context/plan/m.md' } })).toEqual({ behavior: 'allow' })
    expect(policy({ toolName: 'Write', toolInput: { file_path: join(layout.plansDir, 'm.md') } })).toEqual({ behavior: 'allow' })
    expect(policy({ toolName: 'Write', toolInput: { file_path: join(layout.storageDir, 'src', 'a.ts') } })).toMatchObject({ behavior: 'deny' })
  })
})

describe('managed：写入落点保持改造前行为', () => {
  test('Given managed 会话 When 准备 settings + 生图一轮 Then 产物仍在会话目录', async () => {
    writeWorkspacesIndex([managedEntry('default')])
    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)

    ensureAgentSessionSdkSettings({ storageDir: layout.storageDir, plansDirectory: layout.plansDirectory })
    expect(readSettings(join(layout.storageDir, '.claude', 'settings.json')).plansDirectory).toBe('.context')

    const output = await writeAgentImageOutput(pngBytes(), 'image/png', {
      agentCwd: layout.storageDir,
      storageDir: layout.storageDir,
      allowedRoots: [],
    })
    expect(output.image.localPath.startsWith(realpathSync(join(layout.storageDir, '.context', 'agent-output-images')))).toBe(true)

    await createImageGenerationRecord({
      sessionId: meta.id,
      agentCwd: layout.storageDir,
      storageDir: layout.storageDir,
      toolCallId: 'tool-1',
      prompt: 'managed',
      reference: { kind: 'none' },
    })
    expect(existsSync(join(layout.storageDir, '.context', 'image-generations.jsonl'))).toBe(true)
  })

  test('Given 未传 storageDir 的旧调用方 When 生图 Then 回落 cwd（不破坏既有调用）', async () => {
    const root = makeProject('legacy-caller')
    const output = await writeAgentImageOutput(pngBytes(), 'image/png', { agentCwd: root, allowedRoots: [] })
    expect(output.image.localPath.startsWith(join(root, '.context', 'agent-output-images'))).toBe(true)
  })
})
