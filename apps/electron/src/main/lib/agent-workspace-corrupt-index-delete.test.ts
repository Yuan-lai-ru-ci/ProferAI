/**
 * P1-5：索引条目缺 `storageMode` 时不得静默降级 managed
 *
 * 背景（审查报告 P1-5）：`rootPath` 丢失/被外部工具抹掉 `storageMode` 时，条目曾降级为
 * managed，UI 把「移除项目」变回「删除」，点击后级联删掉该项目的全部会话历史。
 *
 * 现在的契约：
 * - 有合法绝对 `rootPath` → project（locator 与 manager 一致），删除只删索引，绝不级联删会话；
 * - 没有合法 `rootPath` → managed（I1：正常 managed 条目没有 rootPath，行为逐字不变）。
 *
 * 环境隔离方式与 agent-workspace-project-lifecycle.test.ts 一致：mock electron + 临时配置根。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const runId = `${process.pid}-${Date.now()}`
const configRoot = join(tmpdir(), `profer-corrupt-index-config-${runId}`)
const sandbox = join(tmpdir(), `profer-corrupt-index-roots-${runId}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { deleteAgentWorkspace, readIndex, removeProjectWorkspace, updateAgentWorkspace, writeIndex } = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation, resolveWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(configRoot, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(configRoot, { recursive: true })
  mkdirSync(sandbox, { recursive: true })
  invalidateWorkspaceLocation()
})

function writeRawIndex(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }, null, 2), 'utf-8')
  invalidateWorkspaceLocation()
}

function readIndexFile(): { version: number; workspaces: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(indexPath, 'utf-8'))
}

function defaultEntry(): Record<string, unknown> {
  return {
    id: 'id-default', name: '默认', slug: 'default', createdAt: 1, updatedAt: 1,
    type: 'personal', storageMode: 'managed',
  }
}

/** 真实项目目录 + `.profer` 骨架 + 会话记录（模拟用户正在用的项目）。 */
function makeProject(name: string, workspaceId: string): { root: string; sessionsRaw: string; messagesPath: string } {
  const root = join(sandbox, name)
  mkdirSync(join(root, '.profer', 'presets'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf-8')
  writeFileSync(join(root, '.profer', 'profer.json'), '{"schema":"profer.project/1"}\n', 'utf-8')

  const messagesPath = join(configRoot, 'agent-sessions', `sess-${name}.jsonl`)
  mkdirSync(join(configRoot, 'agent-sessions'), { recursive: true })
  writeFileSync(messagesPath, '{"type":"user"}\n', 'utf-8')
  const sessionsRaw = `${JSON.stringify({
    sessions: [{ id: `sess-${name}`, title: 'project session', workspaceId, createdAt: 1, updatedAt: 1 }],
  }, null, 2)}\n`
  writeFileSync(sessionsIndexPath, sessionsRaw, 'utf-8')
  return { root, sessionsRaw, messagesPath }
}

describe('P1-5 缺 storageMode 但有 rootPath 的条目', () => {
  test('When 解析位置 Then project（不静默降级 managed）', () => {
    const root = join(sandbox, 'no-mode')
    mkdirSync(root, { recursive: true })
    writeRawIndex([
      defaultEntry(),
      // 外部工具抹掉 storageMode：只剩 slug + rootPath
      { id: 'id-corrupt', name: '损坏项目', slug: 'corrupt', createdAt: 1, updatedAt: 1, type: 'personal', rootPath: root },
    ])

    const location = resolveWorkspaceLocation('corrupt')
    expect(location.mode).toBe('project')
    expect(location.rootPath).toBe(realpathSync(root))
    expect(location.configDir).toBe(join(realpathSync(root), '.profer'))

    // manager 的 normalize 与 locator 一致
    const entry = readIndex().workspaces.find((workspace) => workspace.id === 'id-corrupt')
    expect(entry?.storageMode).toBe('project')
    // 关键：rootPath 不被删掉（否则后续删除会走 managed 级联分支）
    expect(entry?.rootPath).toBe(root)
  })

  test('When 删除该工作区 Then 只删索引，不级联删会话、不碰项目目录', () => {
    const fixture = makeProject('corrupt-delete', 'id-corrupt')
    const canonicalRoot = realpathSync(fixture.root)
    writeRawIndex([
      defaultEntry(),
      { id: 'id-corrupt', name: '损坏项目', slug: 'corrupt', createdAt: 1, updatedAt: 1, type: 'personal', rootPath: canonicalRoot },
    ])

    deleteAgentWorkspace('id-corrupt')

    // 索引条目消失
    expect(readIndexFile().workspaces.map((workspace) => workspace.id)).toEqual(['id-default'])
    expect(readFileSync(indexPath, 'utf-8')).not.toContain('id-corrupt')

    // 会话记录原样保留（修复前这里会被 deleteAgentSessionsByWorkspace 真删）
    expect(readFileSync(sessionsIndexPath, 'utf-8')).toBe(fixture.sessionsRaw)
    expect(existsSync(fixture.messagesPath)).toBe(true)

    // 项目目录与 .profer 完整
    expect(existsSync(join(canonicalRoot, 'package.json'))).toBe(true)
    expect(existsSync(join(canonicalRoot, '.profer', 'profer.json'))).toBe(true)
    expect(existsSync(join(canonicalRoot, '.profer', 'presets'))).toBe(true)
  })

  test('writeIndex 归一化补写 storageMode=project 并落盘 rootPath', () => {
    const root = join(sandbox, 'write-normalize')
    mkdirSync(root, { recursive: true })

    writeIndex({
      version: 4,
      workspaces: [
        defaultEntry(),
        { id: 'id-fixed', name: '待修复', slug: 'fixed', createdAt: 1, updatedAt: 1, type: 'personal', rootPath: root },
      ] as never,
    })

    const onDisk = readIndexFile().workspaces.find((workspace) => workspace.id === 'id-fixed')
    expect(onDisk?.storageMode).toBe('project')
    expect(onDisk?.rootPath).toBe(realpathSync(root))
    expect(resolveWorkspaceLocation('fixed').mode).toBe('project')
  })

  test('v3 索引里带 rootPath 的条目 When 迁移 Then 仍是 project（不删 rootPath）', () => {
    const root = join(sandbox, 'v3-project')
    mkdirSync(root, { recursive: true })
    writeRawIndex([
      defaultEntry(),
      { id: 'id-v3', name: 'v3 项目', slug: 'v3', createdAt: 1, updatedAt: 1, type: 'personal', rootPath: root },
    ])
    // 把版本改回 3 触发迁移
    const raw = readIndexFile()
    writeFileSync(indexPath, JSON.stringify({ ...raw, version: 3 }, null, 2), 'utf-8')
    invalidateWorkspaceLocation()

    const index = readIndex()
    const migrated = index.workspaces.find((workspace) => workspace.id === 'id-v3')
    expect(migrated?.storageMode).toBe('project')
    expect(migrated?.rootPath).toBe(realpathSync(root))
    expect(readIndexFile().version).toBe(4)
  })
})

describe('I1：正常 managed 条目的行为逐字不变', () => {
  test('无 rootPath 的 managed 条目 When 解析 Then managed', () => {
    writeRawIndex([defaultEntry()])

    const location = resolveWorkspaceLocation('default')
    expect(location.mode).toBe('managed')
    expect(location.configDir).toBe(join(configRoot, 'agent-workspaces', 'default'))
    expect(readIndex().workspaces[0]?.storageMode).toBe('managed')
    expect(readIndex().workspaces[0]?.rootPath).toBeUndefined()
  })

  test('无 rootPath 的 managed 条目 When 删除 Then 仍走 managed 分支（删自己的工作区目录）', () => {
    const managedDir = join(configRoot, 'agent-workspaces', 'managed-ws')
    mkdirSync(managedDir, { recursive: true })
    writeFileSync(join(managedDir, 'profile.md'), '# profile\n', 'utf-8')
    writeRawIndex([
      defaultEntry(),
      { id: 'id-managed', name: '托管', slug: 'managed-ws', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' },
    ])

    deleteAgentWorkspace('id-managed')

    expect(readIndexFile().workspaces.map((workspace) => workspace.id)).toEqual(['id-default'])
    expect(existsSync(managedDir)).toBe(false)
  })
})

describe('P1-残留-2：project 条目丢失 rootPath 时不得静默级联删会话', () => {
  test('When 读取 Then 明确标记 degradedFromProject，位置按 managed 解释但不冒充普通托管', () => {
    writeRawIndex([
      defaultEntry(),
      { id: 'id-degraded', name: '丢根项目', slug: 'degraded', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project' },
    ])

    const entry = readIndex().workspaces.find((workspace) => workspace.id === 'id-degraded')
    expect(entry?.storageMode).toBe('project')
    expect(entry?.degradedFromProject).toBe(true)
    expect(entry?.rootPath).toBeUndefined()

    const location = resolveWorkspaceLocation('degraded')
    // 没有 rootPath 就无法定位项目根：位置解析只能走 managed，但必须带降级标记
    expect(location.mode).toBe('managed')
    expect(location.configDir).toBe(join(configRoot, 'agent-workspaces', 'degraded'))
    expect(location.degradedFromProject).toBe(true)
  })

  test('When 删除该工作区 Then 只删索引，会话与消息文件全部保留', () => {
    const fixture = makeProject('degraded-delete', 'id-degraded')
    const canonicalRoot = realpathSync(fixture.root)
    writeRawIndex([
      defaultEntry(),
      { id: 'id-degraded', name: '丢根项目', slug: 'degraded', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project' },
    ])

    deleteAgentWorkspace('id-degraded')

    // 索引条目消失（只删索引）
    expect(readIndexFile().workspaces.map((workspace) => workspace.id)).toEqual(['id-default'])
    expect(readIndex().workspaces.find((workspace) => workspace.id === 'id-degraded')).toBeUndefined()

    // 会话记录原样保留（修复前这里会被 deleteAgentSessionsByWorkspace 真删）
    expect(readFileSync(sessionsIndexPath, 'utf-8')).toBe(fixture.sessionsRaw)
    expect(existsSync(fixture.messagesPath)).toBe(true)

    // 项目目录与 .profer 完整
    expect(existsSync(join(canonicalRoot, 'package.json'))).toBe(true)
    expect(existsSync(join(canonicalRoot, '.profer', 'profer.json'))).toBe(true)
  })

  test('When 走项目移除入口 Then 成功且会话保留（IPC 的 project 分支可用）', () => {
    const fixture = makeProject('degraded-remove', 'id-degraded')
    writeRawIndex([
      defaultEntry(),
      { id: 'id-degraded', name: '丢根项目', slug: 'degraded', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project' },
    ])

    removeProjectWorkspace('id-degraded')

    expect(readIndexFile().workspaces.map((workspace) => workspace.id)).toEqual(['id-default'])
    expect(readFileSync(sessionsIndexPath, 'utf-8')).toBe(fixture.sessionsRaw)
    expect(existsSync(fixture.messagesPath)).toBe(true)
  })

  test('v3 索引里 project 条目缺 rootPath When 迁移 Then 保持 project + 降级标记，不洗成 managed', () => {
    writeRawIndex([
      defaultEntry(),
      { id: 'id-degraded', name: '丢根项目', slug: 'degraded', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project' },
    ])
    // 把版本改回 3 触发迁移
    const raw = readIndexFile()
    writeFileSync(indexPath, JSON.stringify({ ...raw, version: 3 }, null, 2), 'utf-8')
    invalidateWorkspaceLocation()

    const entry = readIndex().workspaces.find((workspace) => workspace.id === 'id-degraded')
    expect(entry?.storageMode).toBe('project')
    expect(entry?.degradedFromProject).toBe(true)
    expect(entry?.rootPath).toBeUndefined()
    expect(readIndexFile().version).toBe(4)
    // 降级标记随迁移落盘，重启后仍能阻止级联删会话
    const onDisk = readIndexFile().workspaces.find((workspace) => workspace.id === 'id-degraded')
    expect(onDisk?.degradedFromProject).toBe(true)
  })

  test('When 无关写入（改名）落盘降级条目 Then 不被 project 必须有 rootPath 的校验阻塞', () => {
    writeRawIndex([
      defaultEntry(),
      { id: 'id-degraded', name: '丢根项目', slug: 'degraded', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project' },
    ])

    expect(() => updateAgentWorkspace('id-default', { name: '默认改名' })).not.toThrow()
    expect(readIndexFile().workspaces.map((workspace) => workspace.name)).toContain('默认改名')
  })
})
