/**
 * P0-A3-3b：会话运行时写路径收口
 *
 * 锁住三条不变量：
 * - I1 managed：会话私有写入布局与改造前逐字一致（storageDir = cwd = `<configDir>/<sessionId>`，
 *   `plansDirectory` 仍是 `.context`）；
 * - I3 project：会话产物（`.claude/settings.json`、`.context/`、`.context/plan/`、生图输出、
 *   诊断日志）全部落在中央 storageDir，rootPath 内**不出现任何一个**；
 * - 计划目录只有一套真相：`agent-session-manager` 的写入布局与提示词里给模型的计划路径相同。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-session-write-paths-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { createAgentSession, resolveAgentSessionCwd, resolveAgentSessionWriteLayout, ensureAgentSessionWriteLayout } =
  await import('./agent-session-manager')
const { buildSystemPrompt } = await import('./agent-prompt-builder')
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

/** 建一个真实存在的项目根（带用户自己的文件与会话产物同名陷阱）。 */
function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  for (const file of ['src/a.ts', 'package.json', '.profer/mcp.json']) {
    const full = join(root, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content:${file}\n`, 'utf-8')
  }
  return realpathSync(root)
}

/** 项目根快照：相对路径列表（含文件内容长度），用于断言「一个字节都没动」。 */
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

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

/** 会话创建时可能落在会话目录里的历史落点（本次要求全部不进项目根）。 */
const SESSION_ARTIFACTS = ['agent-output-images', 'session-errors.log'] as const

describe('project：会话创建只写中央 storageDir', () => {
  test('Given project 工作区 When 创建会话 Then rootPath 不出现任何会话产物', () => {
    const root = makeProject('write-session')
    const before = snapshotTree(root)
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])

    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)

    // 项目根一个字节都没动：没有 .claude/、没有 .context/、没有日志与生图目录
    expect(snapshotTree(root)).toEqual(before)
    expect(existsSync(join(root, '.claude'))).toBe(false)
    expect(existsSync(join(root, '.context'))).toBe(false)
    for (const artifact of SESSION_ARTIFACTS) {
      expect(existsSync(join(root, '.context', artifact))).toBe(false)
      expect(existsSync(join(root, artifact))).toBe(false)
    }

    // cwd 仍是项目根（只作为运行时基准，不作为写目标）
    expect(resolveAgentSessionCwd('p1', meta.id)).toBe(root)
  })

  test('Given project 工作区 When 创建会话 Then settings / context / plan 全部落在 storageDir', () => {
    const root = makeProject('write-layout')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])

    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)

    expect(layout.storageDir).toBe(join(workspacesDir, 'p1', 'sessions', meta.id))
    expect(layout.storageDir.startsWith(root)).toBe(false)

    // 1) SDK settings
    expect(existsSync(layout.claudeSettingsPath)).toBe(true)
    const settings = readSettings(layout.claudeSettingsPath)
    expect(settings.skipWebFetchPreflight).toBe(true)

    // 2) plansDirectory 必须能在「相对项目根」语义下解析回 storageDir：
    //    join 与 resolve 两种实现都要落到中央目录，绝不能落进项目根
    const plansDirectory = settings.plansDirectory
    expect(typeof plansDirectory).toBe('string')
    expect(isAbsolute(plansDirectory as string)).toBe(false)
    expect(resolve(root, plansDirectory as string)).toBe(layout.contextDir)
    expect(join(root, plansDirectory as string)).toBe(layout.contextDir)

    // 3) 会话级 .context 与计划目录已准备好（Profer 不建隐式父目录）
    expect(existsSync(layout.contextDir)).toBe(true)
    expect(existsSync(layout.plansDir)).toBe(true)

    // 4) 生图输出与诊断日志的落点也在 storageDir，且不在项目内
    for (const dir of [layout.plansDir, layout.imageOutputDir]) {
      expect(dir.startsWith(layout.storageDir)).toBe(true)
      expect(dir.startsWith(root)).toBe(false)
    }
    expect(layout.errorsLogPath.startsWith(layout.storageDir)).toBe(true)
    expect(layout.errorsLogPath.startsWith(root)).toBe(false)
  })

  test('Given project 工作区 When 提示词带计划的绝对路径 Then 与写入布局同一目录', () => {
    const root = makeProject('write-plan')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])

    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)
    const prompt = buildSystemPrompt({
      workspaceName: 'write-plan',
      workspaceSlug: 'p1',
      sessionId: meta.id,
      permissionMode: 'plan',
    })

    // 计划文件路径 = 写入布局的 plansDir（唯一真相），且不复用项目根的相对路径
    expect(prompt).toContain(layout.plansDir)
    expect(prompt).not.toContain('将计划文件写入当前工作目录的 `.context/plan/`')
    expect(layout.plansDir.startsWith(root)).toBe(false)

    // 非计划模式不打印中央运行目录：工作区段的「单一路径语义」不许把模型引回 managed 形状路径
    const idlePrompt = buildSystemPrompt({
      workspaceName: 'write-plan',
      workspaceSlug: 'p1',
      sessionId: meta.id,
      permissionMode: 'auto',
    })
    expect(idlePrompt).not.toContain(layout.storageDir)
    expect(idlePrompt).toContain('**会话运行目录**的 `.context/plan/`')
  })
})

describe('managed：写入布局与改造前逐字一致（I1）', () => {
  test('Given managed 工作区 When 创建会话 Then storageDir = cwd = <configDir>/<sessionId> 且 plansDirectory 仍是 .context', () => {
    writeWorkspacesIndex([managedEntry('default')])

    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const storageDir = join(workspacesDir, 'default', meta.id)
    const layout = resolveAgentSessionWriteLayout('default', meta.id)

    expect(layout.storageDir).toBe(storageDir)
    expect(resolveAgentSessionCwd('default', meta.id)).toBe(storageDir)
    expect(layout.contextDir).toBe(join(storageDir, '.context'))
    expect(layout.plansDir).toBe(join(storageDir, '.context', 'plan'))

    expect(existsSync(join(storageDir, '.claude', 'settings.json'))).toBe(true)
    expect(readSettings(join(storageDir, '.claude', 'settings.json')).plansDirectory).toBe('.context')
    expect(existsSync(join(storageDir, '.context'))).toBe(true)
    expect(existsSync(join(storageDir, '.context', 'plan'))).toBe(true)
  })

  test('Given managed 工作区 When 提示词处于计划模式 Then 文案与改造前一致（相对 cwd）', () => {
    writeWorkspacesIndex([managedEntry('default')])

    const meta = createAgentSession('managed session', undefined, 'id-default', undefined, 'claude', false)
    const prompt = buildSystemPrompt({
      workspaceName: 'default',
      workspaceSlug: 'default',
      sessionId: meta.id,
      permissionMode: 'plan',
    })

    expect(prompt).toContain('将计划文件写入当前工作目录的 `.context/plan/` 子目录')
  })
})

describe('布局辅助函数的边界', () => {
  test('Given 重复调用 When 准备布局 Then 保留 settings 中既有键（幂等合并）', () => {
    const root = makeProject('write-idempotent')
    writeWorkspacesIndex([projectEntry('p1', root), managedEntry('default')])
    const meta = createAgentSession('project session', undefined, 'id-p1', undefined, 'claude', false)
    const layout = resolveAgentSessionWriteLayout('p1', meta.id)

    // 模拟用户/SDK 后续写入的字段
    const settings = readSettings(layout.claudeSettingsPath)
    writeFileSync(layout.claudeSettingsPath, JSON.stringify({ ...settings, model: 'keep-me' }, null, 2), 'utf-8')

    ensureAgentSessionWriteLayout('p1', meta.id)

    const after = readSettings(layout.claudeSettingsPath)
    expect(after.model).toBe('keep-me')
    expect(after.plansDirectory).toBe(settings.plansDirectory)
  })

  test('Given project rootPath 不存在 When 解析布局 Then 抛错而不是回退到项目根', () => {
    const missingRoot = join(sandbox, 'projects', 'missing-root')
    writeWorkspacesIndex([projectEntry('p-missing', missingRoot), managedEntry('default')])

    expect(() => resolveAgentSessionWriteLayout('p-missing', 'sess-x')).toThrow()
    expect(existsSync(missingRoot)).toBe(false)
  })
})
