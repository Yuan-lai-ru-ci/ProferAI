/**
 * P1-C：watcher 多根（managed 根 + 每个项目 `.profer`）
 *
 * 锁住设计 §7 与验收 A11：
 * - project 的 `.profer/mcp.json`（及 skills/、presets/、mcp.local.json）变化 → CAPABILITIES_CHANGED
 * - 项目源码树（`.profer` 之外）变化 → 不产生任何事件（交给 git diff / 预览链路）
 * - `.profer/sessions/`、`.profer/cache/`、噪声目录 → 不产生事件
 * - 工作区增删后监听根集合正确（索引变化触发增量同步，不重复监听）
 *
 * 纯函数（computeProjectWatchRoots）负责根集合，集成用例用真实 fs.watch 验证事件映射。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_IPC_CHANNELS } from '@profer/shared'

process.env.PROFER_DEV = '1'

const {
  computeProjectWatchRoots,
  getWatchedProjectConfigDirs,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
  syncProjectWorkspaceWatchers,
} = await import('./workspace-watcher')
const { invalidateWorkspaceLocation, resolveWorkspaceLocation } = await import('./workspace-locator')

const CAPABILITIES = AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED
const FILES = AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED

const sandbox = mkdtempSync(join(tmpdir(), 'profer-watcher-project-'))
const configRoot = join(sandbox, 'config')
const indexPath = join(configRoot, 'agent-workspaces.json')

/** 渲染进程收到的事件（按顺序） */
let sent: string[] = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string) => { sent.push(channel) } },
} as unknown as BrowserWindow

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configRoot
  mkdirSync(configRoot, { recursive: true })
  invalidateWorkspaceLocation()
  sent = []
})

afterEach(() => {
  stopWorkspaceWatcher()
  rmSync(indexPath, { force: true })
  rmSync(`${indexPath}.tmp`, { force: true })
  rmSync(`${indexPath}.bak`, { force: true })
  invalidateWorkspaceLocation()
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
  delete process.env.PROFER_CONFIG_DIR
})

function makeProject(name: string): string {
  const root = join(sandbox, name)
  mkdirSync(join(root, '.profer'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf-8')
  return realpathSync(root)
}

function writeIndex(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
}

function projectEntry(slug: string, rootPath: string): Record<string, unknown> {
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

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

/** 等待防抖窗口（DEBOUNCE_MS=300）过去，用于断言「没有事件」。 */
async function settle(ms = 900): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 启动监听并等首次 FSEvents 回灌结束（启动瞬间可能收到启动前写入的迟到事件）。 */
async function startAndSettle(): Promise<void> {
  startWorkspaceWatcher(fakeWindow)
  await settle()
  sent = []
}

describe('computeProjectWatchRoots（纯函数）', () => {
  test('只取 project 工作区，根为 <rootPath>/.profer，managed 一律跳过', () => {
    const roots = computeProjectWatchRoots(
      [{ slug: 'managed-a' }, { slug: 'project-a', storageMode: 'project' }],
      (slug) => (slug === 'project-a'
        ? { configDir: '/projects/a/.profer', rootPath: '/projects/a', mode: 'project' as const }
        : { configDir: '/config/agent-workspaces/managed-a', rootPath: '/config/agent-workspaces/managed-a', mode: 'managed' as const }),
      () => true,
    )

    expect(roots).toEqual([{ slug: 'project-a', rootPath: '/projects/a', configDir: '/projects/a/.profer' }])
  })

  test('同一项目多条索引（或同 configDir）只产出一次，不重复监听', () => {
    const locate = () => ({ configDir: '/projects/a/.profer', rootPath: '/projects/a', mode: 'project' as const })
    const roots = computeProjectWatchRoots(
      [{ slug: 'project-a', storageMode: 'project' }, { slug: 'project-a-dup', storageMode: 'project' }],
      locate,
      () => true,
    )

    expect(roots).toHaveLength(1)
    expect(roots[0]!.configDir).toBe('/projects/a/.profer')
  })

  test('.profer 尚不存在时跳过（不监听、也不 mkdir，I4）', () => {
    const roots = computeProjectWatchRoots(
      [{ slug: 'project-a', storageMode: 'project' }],
      () => ({ configDir: '/projects/a/.profer', rootPath: '/projects/a', mode: 'project' as const }),
      () => false,
    )

    expect(roots).toEqual([])
  })

  test('工作区增删后根集合随之变化（新增出现、移除消失）', () => {
    const locate = (slug: string) => (slug === 'managed-a'
      ? { configDir: '/config/agent-workspaces/managed-a', rootPath: '/config/agent-workspaces/managed-a', mode: 'managed' as const }
      : { configDir: `/projects/${slug}/.profer`, rootPath: `/projects/${slug}`, mode: 'project' as const })
    const dirExists = () => true

    const before = computeProjectWatchRoots(
      [{ slug: 'managed-a' }, { slug: 'proj-1', storageMode: 'project' }],
      locate,
      dirExists,
    )
    expect(before.map((root) => root.configDir)).toEqual(['/projects/proj-1/.profer'])

    const afterAdd = computeProjectWatchRoots(
      [{ slug: 'managed-a' }, { slug: 'proj-1', storageMode: 'project' }, { slug: 'proj-2', storageMode: 'project' }],
      locate,
      dirExists,
    )
    expect(afterAdd.map((root) => root.configDir)).toEqual(['/projects/proj-1/.profer', '/projects/proj-2/.profer'])

    const afterRemove = computeProjectWatchRoots(
      [{ slug: 'managed-a' }, { slug: 'proj-2', storageMode: 'project' }],
      locate,
      dirExists,
    )
    expect(afterRemove.map((root) => root.configDir)).toEqual(['/projects/proj-2/.profer'])
  })
})

describe('watcher 多根（真实 fs.watch）', () => {
  test('.profer 内的 MCP / Skills / 预设变化推 CAPABILITIES_CHANGED，项目源码变化不推任何事件', async () => {
    const projectRoot = makeProject('alpha')
    const projectConfigDir = join(projectRoot, '.profer')
    writeIndex([projectEntry('proj-alpha', projectRoot)])
    invalidateWorkspaceLocation()

    await startAndSettle()

    // 根集合：只监听项目 `.profer`，不监听项目根
    expect(await waitFor(() => getWatchedProjectConfigDirs().includes(projectConfigDir))).toBe(true)
    expect(getWatchedProjectConfigDirs()).toEqual([projectConfigDir])

    // 1) mcp.json → 能力事件
    sent = []
    writeFileSync(join(projectConfigDir, 'mcp.json'), '{"servers":{}}\n', 'utf-8')
    expect(await waitFor(() => sent.includes(CAPABILITIES))).toBe(true)

    // 2) mcp.local.json（本机覆盖层）同样应刷新能力
    sent = []
    writeFileSync(join(projectConfigDir, 'mcp.local.json'), '{"servers":{}}\n', 'utf-8')
    expect(await waitFor(() => sent.includes(CAPABILITIES))).toBe(true)

    // 3) 项目源码树变化 → 没有任何事件
    sent = []
    writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export const a = 1\n', 'utf-8')
    writeFileSync(join(projectRoot, 'index.ts'), 'export const b = 2\n', 'utf-8')
    await settle()
    expect(sent).toEqual([])
    expect(sent).not.toContain(FILES)
  })

  test('sessions/ 与 cache/ 不产生事件，其余 `.profer` 文件推 WORKSPACE_FILES_CHANGED', async () => {
    const projectRoot = makeProject('beta')
    const projectConfigDir = join(projectRoot, '.profer')
    mkdirSync(join(projectConfigDir, 'sessions', 'sess-1'), { recursive: true })
    mkdirSync(join(projectConfigDir, 'cache'), { recursive: true })
    writeIndex([projectEntry('proj-beta', projectRoot)])
    invalidateWorkspaceLocation()

    await startAndSettle()
    expect(await waitFor(() => getWatchedProjectConfigDirs().includes(projectConfigDir))).toBe(true)

    sent = []
    writeFileSync(join(projectConfigDir, 'sessions', 'sess-1', 'messages.jsonl'), '{}\n', 'utf-8')
    writeFileSync(join(projectConfigDir, 'cache', 'dump.json'), '{}\n', 'utf-8')
    await settle()
    expect(sent).toEqual([])

    // profile.md 属于工作区资产 → 文件树刷新（不是能力刷新）
    sent = []
    writeFileSync(join(projectConfigDir, 'profile.md'), '# profile\n', 'utf-8')
    expect(await waitFor(() => sent.includes(FILES))).toBe(true)
    expect(sent).not.toContain(CAPABILITIES)

    // 用户文件树里同名的 mcp.json 不算能力变更（只认 `.profer` 顶层）
    sent = []
    mkdirSync(join(projectConfigDir, 'workspace-files'), { recursive: true })
    writeFileSync(join(projectConfigDir, 'workspace-files', 'mcp.json'), '{}\n', 'utf-8')
    expect(await waitFor(() => sent.includes(FILES))).toBe(true)
    expect(sent).not.toContain(CAPABILITIES)

    // skills/ 属于能力
    sent = []
    mkdirSync(join(projectConfigDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(projectConfigDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n', 'utf-8')
    expect(await waitFor(() => sent.includes(CAPABILITIES))).toBe(true)
  })

  test('索引增删工作区后动态增删监听根，且不重复监听', async () => {
    const first = makeProject('gamma')
    const second = makeProject('delta')
    writeIndex([projectEntry('proj-gamma', first)])
    invalidateWorkspaceLocation()

    await startAndSettle()
    const firstConfigDir = join(first, '.profer')
    const secondConfigDir = join(second, '.profer')
    expect(await waitFor(() => getWatchedProjectConfigDirs().includes(firstConfigDir))).toBe(true)
    expect(getWatchedProjectConfigDirs()).toEqual([firstConfigDir])

    // 新增工作区（写索引 → 索引监听 → 增量同步）
    writeIndex([projectEntry('proj-gamma', first), projectEntry('proj-delta', second)])
    invalidateWorkspaceLocation()
    expect(await waitFor(() => getWatchedProjectConfigDirs().length === 2)).toBe(true)
    expect(getWatchedProjectConfigDirs()).toEqual([firstConfigDir, secondConfigDir].sort())

    // 重复同步不产生重复监听
    syncProjectWorkspaceWatchers()
    expect(getWatchedProjectConfigDirs()).toEqual([firstConfigDir, secondConfigDir].sort())

    // 新根的监听真的生效
    sent = []
    writeFileSync(join(secondConfigDir, 'mcp.json'), '{"servers":{}}\n', 'utf-8')
    expect(await waitFor(() => sent.includes(CAPABILITIES))).toBe(true)

    // 移除工作区 → 监听随之移除
    writeIndex([projectEntry('proj-gamma', first)])
    invalidateWorkspaceLocation()
    expect(await waitFor(() => getWatchedProjectConfigDirs().length === 1)).toBe(true)
    expect(getWatchedProjectConfigDirs()).toEqual([firstConfigDir])
  })

  test('managed 工作区不进入 project 根集合，project 条目的 rootPath 不存在时也不监听', async () => {
    const projectRoot = makeProject('epsilon')
    writeIndex([
      { id: 'id-managed', name: '遗留', slug: 'managed-x', createdAt: 1, updatedAt: 1, type: 'personal' },
      projectEntry('proj-epsilon', projectRoot),
      projectEntry('proj-ghost', join(sandbox, 'does-not-exist')),
    ])
    invalidateWorkspaceLocation()

    expect(resolveWorkspaceLocation('managed-x').mode).toBe('managed')

    await startAndSettle()
    expect(await waitFor(() => getWatchedProjectConfigDirs().includes(join(projectRoot, '.profer')))).toBe(true)
    expect(getWatchedProjectConfigDirs()).toEqual([join(projectRoot, '.profer')])
  })
})
