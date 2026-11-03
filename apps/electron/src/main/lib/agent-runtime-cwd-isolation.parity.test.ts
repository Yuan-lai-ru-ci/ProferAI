/**
 * P0-A3-1：cwd 链路接入与 parity 护栏
 *
 * 设计文档引用了这个文件（`docs/plans/2026-11-03-workspace-project-mode-implementation.md`），
 * 但仓库里一直没有实现。这里补上断言矩阵，锁住四条不变量：
 *
 * - I1 managed：cwd = `<configDir>/<sessionId>`，且**不等于** `<configDir>`（禁止退化回工作区根）
 * - I2/I3 project：cwd = `rootPath`（同项目多会话共享，设计 §7.3），storageDir 在中央且 ≠ rootPath
 * - 无工作区：cwd = 用户主目录（改造前的旧行为）
 * - 两条宿主链（`AgentOrchestrator.sendMessage` 与 `buildRuntimeHeadlessRunContext`）同源：
 *   都调 `resolveAgentSessionCwd`，任何一侧都不许再把 storageDir 当 cwd
 *
 * 最后两条用源码断言：两条链的 cwd 计算是宿主内联代码，没有可注入入口；
 * 与其为测试再造一个导出面，不如把「不许再出现旧写法」钉在源码上（与 P0-A2 的守卫测试同一手法）。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

const sandbox = mkdtempSync(join(tmpdir(), 'profer-cwd-parity-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { getAgentSessionCwd, getAgentSessionStorageDir } = await import('./config-paths')
const { resolveAgentSessionCwd, shouldSkipPiFileCheckpoint } = await import('./agent-session-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const INDEX_PATH = join(configRoot, 'agent-workspaces.json')
const SLUG = 'ws-parity'
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(INDEX_PATH, { force: true })
  rmSync(`${INDEX_PATH}.bak`, { force: true })
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

function writeWorkspaceIndex(workspace: Record<string, unknown>): void {
  mkdirSync(dirname(INDEX_PATH), { recursive: true })
  writeFileSync(INDEX_PATH, JSON.stringify({ version: 4, workspaces: [workspace] }), 'utf-8')
  invalidateWorkspaceLocation()
}

function writeManagedIndex(): void {
  writeWorkspaceIndex({ id: 'ws-parity-id', name: 'parity', slug: SLUG, createdAt: 1, updatedAt: 1, type: 'personal' })
}

/** 建一个真实存在的项目根并写入 project 索引，返回 realpath 归一化后的 rootPath。 */
function writeProjectIndex(): string {
  const projectDir = join(sandbox, 'my-project')
  mkdirSync(projectDir, { recursive: true })
  const rootPath = realpathSync(projectDir)
  writeWorkspaceIndex({
    id: 'ws-parity-id',
    name: 'parity-project',
    slug: SLUG,
    createdAt: 1,
    updatedAt: 1,
    type: 'personal',
    storageMode: 'project',
    rootPath,
  })
  return rootPath
}

describe('managed：cwd 与改造前逐字一致（I1）', () => {
  test('Given managed 工作区 When 解析 cwd Then <configDir>/<sessionId> 且 ≠ 工作区根', () => {
    writeManagedIndex()
    const workspaceDir = join(configRoot, 'agent-workspaces', SLUG)

    expect(getAgentSessionCwd(SLUG, SESSION_A)).toBe(join(workspaceDir, SESSION_A))
    expect(getAgentSessionCwd(SLUG, SESSION_A)).not.toBe(workspaceDir)
    // 两条链共用的入口必须与 config-paths 的结论逐字一致
    expect(resolveAgentSessionCwd(SLUG, SESSION_A)).toBe(getAgentSessionCwd(SLUG, SESSION_A))
  })

  test('Given managed When 取 storageDir Then 与 cwd 相同（历史语义合并，零变化）', () => {
    writeManagedIndex()

    expect(getAgentSessionStorageDir(SLUG, SESSION_A)).toBe(getAgentSessionCwd(SLUG, SESSION_A))
  })

  test('Given 索引里没有该工作区 When 解析 Then 回落 managed，不指向用户目录', () => {
    // 索引缺失 / 条目异常时 locator 一律按 managed 解释（异常数据绝不能指到用户项目）
    expect(getAgentSessionCwd(SLUG, SESSION_A)).toBe(join(configRoot, 'agent-workspaces', SLUG, SESSION_A))
  })
})

describe('project：cwd 共享项目根（设计 §7.1 / §7.3）', () => {
  test('Given project 工作区 When 解析 cwd Then 等于 realpath(rootPath)', () => {
    const rootPath = writeProjectIndex()

    expect(getAgentSessionCwd(SLUG, SESSION_A)).toBe(rootPath)
    expect(resolveAgentSessionCwd(SLUG, SESSION_A)).toBe(rootPath)
  })

  test('Given 同项目两个会话 When 解析 cwd Then 两者相同且都等于 rootPath', () => {
    const rootPath = writeProjectIndex()
    const cwdA = getAgentSessionCwd(SLUG, SESSION_A)
    const cwdB = getAgentSessionCwd(SLUG, SESSION_B)

    expect(cwdA).toBe(cwdB)
    expect(cwdA).toBe(rootPath)
    expect(resolveAgentSessionCwd(SLUG, SESSION_B)).toBe(rootPath)
  })

  test('Given project When 取 storageDir Then 在中央目录、≠ cwd、不在项目内', () => {
    const rootPath = writeProjectIndex()
    const cwd = getAgentSessionCwd(SLUG, SESSION_A)
    const storageDir = getAgentSessionStorageDir(SLUG, SESSION_A)

    expect(storageDir).toBe(join(configRoot, 'agent-workspaces', SLUG, 'sessions', SESSION_A))
    expect(storageDir).not.toBe(rootPath)
    expect(storageDir).not.toBe(cwd)
    expect(storageDir.startsWith(rootPath)).toBe(false)
    // 每个会话仍有独立存储目录（附件 / 检查点互不串线）
    expect(getAgentSessionStorageDir(SLUG, SESSION_B)).not.toBe(storageDir)
  })
})

describe('无工作区：回退用户主目录', () => {
  test('Given 无 workspaceSlug When 解析 cwd Then homedir()', () => {
    expect(resolveAgentSessionCwd(undefined, SESSION_A)).toBe(homedir())
  })
})

describe('两条宿主链同源（源码护栏）', () => {
  async function readSource(file: string): Promise<string> {
    return (await Bun.file(join(import.meta.dir, file)).text()).replace(/\r\n/g, '\n')
  }

  test('Given 旧链（orchestrator）When 解析 agentCwd Then 走 resolveAgentSessionCwd', async () => {
    const source = await readSource('agent-orchestrator.ts')

    expect(source).toContain('agentCwd = resolveAgentSessionCwd(ws.slug, sessionId)')
    expect(source).not.toContain('agentCwd = getAgentSessionWorkspacePath(')
  })

  test('Given 新链（headless run context）When 解析 cwd Then 走 resolveAgentSessionCwd', async () => {
    const source = await readSource('agent-service.ts')

    expect(source).toContain('const cwd = resolveAgentSessionCwd(workspaceSlug, input.sessionId)')
    expect(source).not.toContain('const cwd = getAgentSessionWorkspacePath(')
    expect(source).not.toContain('cwd = getAgentSessionWorkspacePath(workspaceSlug')
  })

  test('Given project 下 cwd = 项目根 When 判定草稿区 Then 基准是 storageDir', async () => {
    const source = await readSource('agent-orchestrator.ts')

    // 用 cwd 判定会把项目内所有改动当成草稿丢弃（chip 全空），必须用 storageDir
    expect(source).toContain('isPathInsideDirectory(fact.path, draftDiscardRoot)')
    expect(source).toContain('const draftDiscardRoot = agentStorageDir ?? agentCwd')
    expect(source).not.toContain('isPathInsideDirectory(fact.path, agentCwd)')
  })

  test('Given project 下 cwd = 项目根 When Pi 建/恢复检查点 Then 两条链都按 mode 跳过', async () => {
    // 决策唯一来源：project 跳过（建快照与恢复都不做），managed / 无工作区保持原行为
    expect(shouldSkipPiFileCheckpoint({ storageMode: 'project' })).toBe(true)
    expect(shouldSkipPiFileCheckpoint({ storageMode: 'managed' })).toBe(false)
    expect(shouldSkipPiFileCheckpoint({ storageMode: undefined })).toBe(false)
    expect(shouldSkipPiFileCheckpoint(undefined)).toBe(false)

    const [orchestratorSource, serviceSource, sessionManagerSource] = await Promise.all([
      readSource('agent-orchestrator.ts'),
      readSource('agent-service.ts'),
      readSource('agent-session-manager.ts'),
    ])

    // 建快照：旧链 + 新链都必须走同一个门禁（否则每轮全量快照整个项目）
    expect(orchestratorSource).toContain('const skipPiFileCheckpoint = shouldSkipPiFileCheckpoint(workspace)')
    expect(serviceSource).toContain('const skipPiFileCheckpoint = shouldSkipPiFileCheckpoint(workspace)')
    // 恢复快照：绝不以 rootPath 为恢复根（否则 rewind 会删改同项目其它会话的文件）
    expect(sessionManagerSource).toContain('if (shouldSkipPiFileCheckpoint(workspace)) {')
    expect(sessionManagerSource).toContain('restorePiFileCheckpoint(loadPiFileCheckpoint(checkpointPath), cwd)')
  })
})
