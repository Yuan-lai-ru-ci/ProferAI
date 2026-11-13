/**
 * 归档 / 删除会话时自动回收 WebUI 发布位。
 *
 * 覆盖三条路径（缺一条就会留下「已归档但还能访问」的页面）：
 * - 手动归档走 `updateAgentSessionMeta`
 * - 自动归档（按天数阈值）直接改索引，不走上面那条
 * - 删除会话
 *
 * 环境隔离方式与 agent-session-auto-archive.test.ts 一致：mock electron + 临时配置根。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const configRoot = join(tmpdir(), `profer-webui-archive-${Date.now()}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { updateAgentSessionMeta, deleteAgentSession, autoArchiveAgentSessions } = await import('./agent-session-manager')
const { getAgentSessionsIndexPath, getSettingsPath } = await import('./config-paths')
const { clearSettingsCache } = await import('./settings-service')
type AgentSessionMeta = import('@profer/shared').AgentSessionMeta

let mtimeTick = 0

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(configRoot, { recursive: true, force: true })
  // 设置是进程级缓存：直接改盘上的文件后必须清缓存，否则读到的是上一个用例的值
  clearSettingsCache()
  mtimeTick = 0
})

function session(id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  const now = Date.now()
  return { id, title: id, createdAt: now, updatedAt: now, workspaceId: 'ws-1', ...overrides }
}

/** 写会话索引；推进 mtime 让索引缓存放行。 */
function writeSessions(sessions: AgentSessionMeta[]): void {
  const path = getAgentSessionsIndexPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, sessions }, null, 2))
  mtimeTick += 1
  const stamp = new Date(Date.now() + mtimeTick * 1000)
  utimesSync(path, stamp, stamp)
}

function writeSettings(publishedSessionIds: string[]): void {
  mkdirSync(dirname(getSettingsPath()), { recursive: true })
  writeFileSync(getSettingsPath(), JSON.stringify({ webuiEnabled: true, webuiPublishedSessionIds: publishedSessionIds }, null, 2))
}

/** 直接读盘：断言不依赖内存缓存，确保真的落盘了。 */
function publishedOnDisk(): string[] {
  const raw = JSON.parse(readFileSync(getSettingsPath(), 'utf-8')) as { webuiPublishedSessionIds?: string[] }
  return raw.webuiPublishedSessionIds ?? []
}

describe('归档自动撤销 WebUI 发布', () => {
  test('Given 已发布会话被归档 When 更新元数据 Then 发布位立即被移除', () => {
    writeSessions([session('s1'), session('s2')])
    writeSettings(['s1', 's2'])

    updateAgentSessionMeta('s1', { archived: true })

    expect(publishedOnDisk()).toEqual(['s2'])
  })

  test('Given 未发布的会话被归档 When 更新元数据 Then 不碰设置（避免无谓写盘）', () => {
    writeSessions([session('s1')])
    writeSettings(['s2'])
    const before = readFileSync(getSettingsPath(), 'utf-8')

    updateAgentSessionMeta('s1', { archived: true })

    expect(readFileSync(getSettingsPath(), 'utf-8')).toBe(before)
  })

  test('Given 已归档的会话被取消归档 When 更新元数据 Then 不会自动重新发布', () => {
    writeSessions([session('s1', { archived: true })])
    writeSettings([])

    updateAgentSessionMeta('s1', { archived: false })

    expect(publishedOnDisk()).toEqual([])
  })

  test('Given 普通元数据更新 When 更新元数据 Then 不影响发布位（只有归档才动）', () => {
    writeSessions([session('s1')])
    writeSettings(['s1'])

    updateAgentSessionMeta('s1', { pinned: true })

    expect(publishedOnDisk()).toEqual(['s1'])
  })

  test('Given 已发布会话被删除 When 删除会话 Then 发布位被移除', async () => {
    writeSessions([session('s1'), session('s2')])
    writeSettings(['s1', 's2'])

    await deleteAgentSession('s1')

    expect(publishedOnDisk()).toEqual(['s2'])
  })

  test('Given 已发布会话被按天自动归档 When 执行自动归档 Then 发布位同样被移除', () => {
    const old = Date.now() - 90 * 86_400_000
    // 自动归档直接改索引、不走 updateAgentSessionMeta，是最容易漏掉的一条路径
    writeSessions([session('s1', { updatedAt: old }), session('s2')])
    writeSettings(['s1', 's2'])

    const count = autoArchiveAgentSessions(30, 0)

    expect(count).toBe(1)
    expect(publishedOnDisk()).toEqual(['s2'])
  })
})
