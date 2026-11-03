/**
 * 项目工作区生命周期（P1-A）：创建 / 打开 / 移除
 *
 * 覆盖设计 §6.1–§6.3 与验收用例 A1/A5/A7/A9：
 * - 创建：骨架完整、profer.json 内容正确、索引 storageMode/rootPath 正确
 * - 已有 `.profer`：不覆盖既有文件，缺失项补齐
 * - 重复绑定、不可写、不存在、文件系统根：拒绝
 * - 移除：只删索引，项目文件、`.profer`、会话全部保留；允许移除最后一个 project
 * - 索引写入失败：只回滚本次新建的文件，项目既有内容不动
 *
 * 环境隔离方式与 agent-workspace-manager.index-v4.test.ts 一致：mock electron + 临时配置根。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

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
const configRoot = join(tmpdir(), `profer-project-lifecycle-config-${runId}`)
const sandbox = join(tmpdir(), `profer-project-lifecycle-roots-${runId}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  createProjectWorkspace,
  openProjectWorkspace,
  removeProjectWorkspace,
  relocateProjectWorkspace,
  listAgentWorkspaces,
  ProjectWorkspaceError,
} = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')

const SKELETON_DIRS = ['memory', 'skills', 'skills-inactive', 'workspace-files', 'presets']
const SKELETON_FILES = [
  'profer.json',
  'profile.md',
  join('memory', 'MEMORY.md'),
  'mcp.json',
  join('presets', '_config.json'),
  'config.json',
  '.gitignore',
]

function makeProjectRoot(name: string): string {
  const root = join(sandbox, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf-8')
  writeFileSync(join(root, 'index.ts'), 'export const answer = 42\n', 'utf-8')
  return root
}

function readIndexFile(): { version: number; workspaces: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(indexPath, 'utf-8'))
}

beforeEach(() => {
  rmSync(indexPath, { recursive: true, force: true })
  rmSync(`${indexPath}.bak`, { recursive: true, force: true })
  rmSync(`${indexPath}.tmp`, { recursive: true, force: true })
  rmSync(configRoot, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(configRoot, { recursive: true })
  mkdirSync(sandbox, { recursive: true })
  invalidateWorkspaceLocation()
})

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
})

describe('创建项目工作区', () => {
  test('Given 普通文件夹 When 创建 Then 骨架完整、profer.json 正确、索引落 project/rootPath', () => {
    const root = makeProjectRoot('alpha')

    const result = createProjectWorkspace({ rootPath: root, name: '我的项目', proferVersion: '0.16.17' })
    const canonicalRoot = realpathSync(root)
    const proferDir = join(canonicalRoot, '.profer')

    expect(result.created).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.workspace.storageMode).toBe('project')
    expect(result.workspace.rootPath).toBe(canonicalRoot)
    expect(result.workspace.name).toBe('我的项目')
    expect(result.workspace.slug).toMatch(/^[A-Za-z0-9_-]+$/)

    for (const dir of SKELETON_DIRS) {
      expect(statSync(join(proferDir, dir)).isDirectory()).toBe(true)
    }
    for (const file of SKELETON_FILES) {
      expect(existsSync(join(proferDir, file))).toBe(true)
    }
    // 骨架只在 `<root>/.profer` 一层，不允许出现 `<root>/.profer/.profer`
    expect(existsSync(join(proferDir, '.profer'))).toBe(false)

    const manifest = JSON.parse(readFileSync(join(proferDir, 'profer.json'), 'utf-8')) as Record<string, unknown>
    expect(manifest.schema).toBe('profer.project/1')
    expect(manifest.name).toBe('我的项目')
    expect(manifest.proferVersion).toBe('0.16.17')
    expect(typeof manifest.createdAt).toBe('string')
    expect(Number.isNaN(Date.parse(String(manifest.createdAt)))).toBe(false)
    // 清单不写绝对路径/机器标识（设计 §2.3）
    expect(JSON.stringify(manifest)).not.toContain(canonicalRoot)

    expect(JSON.parse(readFileSync(join(proferDir, 'mcp.json'), 'utf-8'))).toEqual({ servers: {} })
    expect(JSON.parse(readFileSync(join(proferDir, 'presets', '_config.json'), 'utf-8'))).toEqual({
      schema: 'profer.presets/1',
      defaultPresetReference: null,
      defaultPresetExplicitlyCleared: false,
      disabledGlobalPresetIds: [],
      disabledWorkspacePresetIds: [],
    })
    expect(readFileSync(join(proferDir, '.gitignore'), 'utf-8')).toBe('sessions/\ncache/\nworkspace-files/\n.runtime/\nskill-overrides.json\n*.local.json\n.lock\n')
    expect(readFileSync(join(proferDir, 'profile.md'), 'utf-8')).toContain('# 我的项目')

    const index = readIndexFile()
    expect(index.version).toBe(4)
    expect(index.workspaces).toHaveLength(1)
    expect(index.workspaces[0]).toMatchObject({
      id: result.workspace.id,
      storageMode: 'project',
      rootPath: canonicalRoot,
    })

    // 项目既有内容不被改动
    expect(readFileSync(join(canonicalRoot, 'index.ts'), 'utf-8')).toContain('answer = 42')
  })

  test('Given 已有 .profer 手写资料 When 创建 Then 不覆盖既有文件、补齐缺失项', () => {
    const root = makeProjectRoot('legacy')
    const proferDir = join(root, '.profer')
    mkdirSync(proferDir, { recursive: true })
    writeFileSync(join(proferDir, 'profile.md'), '# 手写资料\n\n不要覆盖我\n', 'utf-8')

    const result = createProjectWorkspace({ rootPath: root, name: 'legacy', proferVersion: '0.16.17' })

    expect(result.created).toBe(true)
    expect(readFileSync(join(proferDir, 'profile.md'), 'utf-8')).toBe('# 手写资料\n\n不要覆盖我\n')
    // 既有 .profer 里没有清单与骨架：全部补上
    expect(existsSync(join(proferDir, 'profer.json'))).toBe(true)
    expect(existsSync(join(proferDir, 'memory', 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(proferDir, 'presets', '_config.json'))).toBe(true)
    expect(existsSync(join(proferDir, 'mcp.json'))).toBe(true)
  })

  test('Given 已绑定 When 再次创建 Then 拒绝并提示已绑定', () => {
    const root = makeProjectRoot('dup')
    const first = createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })

    let caught: unknown
    try {
      createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProjectWorkspaceError)
    expect((caught as InstanceType<typeof ProjectWorkspaceError>).code).toBe('already-bound')
    expect((caught as Error).message).toContain('已绑定为项目')
    // 拒绝不应产生第二个条目
    expect(listAgentWorkspaces()).toHaveLength(1)
    expect(listAgentWorkspaces()[0]!.id).toBe(first.workspace.id)
  })

  test('Given 路径不存在 / 是文件 / 是相对路径 / 是文件系统根 When 创建 Then 分别拒绝', () => {
    expect(() => createProjectWorkspace({ rootPath: join(sandbox, 'missing'), proferVersion: '0.16.17' }))
      .toThrow('项目路径不存在')

    const filePath = join(sandbox, 'a-file.txt')
    writeFileSync(filePath, 'x', 'utf-8')
    expect(() => createProjectWorkspace({ rootPath: filePath, proferVersion: '0.16.17' }))
      .toThrow('不是文件夹')

    expect(() => createProjectWorkspace({ rootPath: 'relative/project', proferVersion: '0.16.17' }))
      .toThrow('必须是绝对路径')

    expect(() => createProjectWorkspace({ rootPath: parse(process.cwd()).root, proferVersion: '0.16.17' }))
      .toThrow('文件系统根目录')

    expect(listAgentWorkspaces()).toHaveLength(0)
  })

  test('Given 目录不可写 When 创建 Then 拒绝且不落索引', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return

    const root = makeProjectRoot('readonly')
    chmodSync(root, 0o500)
    try {
      expect(() => createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' }))
        .toThrow('项目目录不可写')
      expect(listAgentWorkspaces()).toHaveLength(0)
      expect(existsSync(join(root, '.profer'))).toBe(false)
    } finally {
      chmodSync(root, 0o700)
    }
  })

  test('Given Profer 配置目录内或配置目录父级 When 创建 Then 拒绝', () => {
    const insideConfig = join(configRoot, 'nested-project')
    mkdirSync(insideConfig, { recursive: true })
    expect(() => createProjectWorkspace({ rootPath: insideConfig, proferVersion: '0.16.17' }))
      .toThrow('配置目录')

    // configRoot = <tmp>/xxx，其父目录 <tmp> 一旦被绑定，`<tmp>/.profer` 会撞上全局配置根
    const configParent = parse(configRoot).dir
    expect(() => createProjectWorkspace({ rootPath: configParent, proferVersion: '0.16.17' }))
      .toThrow('配置目录')
  })

  test('Given 索引写入失败 When 创建 Then 只回滚本次新建的骨架，项目既有文件不动', () => {
    const root = makeProjectRoot('rollback')
    // 让索引路径变成目录：原子写入的 rename 会失败
    mkdirSync(indexPath, { recursive: true })

    expect(() => createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })).toThrow()

    expect(existsSync(join(root, '.profer'))).toBe(false)
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    expect(existsSync(join(root, 'index.ts'))).toBe(true)
  })
})

describe('打开已有项目', () => {
  test('Given 已绑定项目 When 打开 Then 复用条目并补齐被删的骨架文件', () => {
    const root = makeProjectRoot('reopen')
    const created = createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
    const proferDir = join(realpathSync(root), '.profer')

    rmSync(join(proferDir, 'mcp.json'))
    rmSync(join(proferDir, 'profer.json'))

    const reopened = openProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })

    expect(reopened.created).toBe(false)
    expect(reopened.workspace.id).toBe(created.workspace.id)
    expect(existsSync(join(proferDir, 'mcp.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(proferDir, 'profer.json'), 'utf-8')) as Record<string, unknown>
    expect(manifest.schema).toBe('profer.project/1')
    expect(manifest.name).toBe(created.workspace.name)
    expect(listAgentWorkspaces()).toHaveLength(1)
  })

  test('Given 骨架完整但只读 When 打开 Then 仍可打开（不强制可写）', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return

    const root = makeProjectRoot('readonly-open')
    const created = createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
    const proferDir = join(realpathSync(root), '.profer')

    chmodSync(proferDir, 0o500)
    try {
      const reopened = openProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
      expect(reopened.created).toBe(false)
      expect(reopened.workspace.id).toBe(created.workspace.id)
    } finally {
      chmodSync(proferDir, 0o700)
    }
  })

  test('Given 只读项目缺骨架文件 When 打开 Then 报不可写而不是崩溃', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return

    const root = makeProjectRoot('readonly-open-missing')
    createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
    const proferDir = join(realpathSync(root), '.profer')
    rmSync(join(proferDir, 'mcp.json'))

    chmodSync(proferDir, 0o500)
    try {
      expect(() => openProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' }))
        .toThrow('项目目录不可写')
    } finally {
      chmodSync(proferDir, 0o700)
    }
  })

  test('Given 未知 schema When 打开 Then 只读打开、给出 warning、不改写文件', () => {
    const root = makeProjectRoot('future')
    const proferDir = join(root, '.profer')
    mkdirSync(proferDir, { recursive: true })
    const futureManifest = `${JSON.stringify({ schema: 'profer.project/2', name: '未来项目', extra: true }, null, 2)}\n`
    writeFileSync(join(proferDir, 'profer.json'), futureManifest, 'utf-8')

    const result = openProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })

    expect(result.created).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.join('\n')).toContain('profer.project/2')
    expect(readFileSync(join(proferDir, 'profer.json'), 'utf-8')).toBe(futureManifest)
    expect(result.workspace.name).toBe('未来项目')
    // 骨架仍然补齐
    expect(existsSync(join(proferDir, 'memory', 'MEMORY.md'))).toBe(true)
  })

  test('Given 损坏的 profer.json When 打开 Then 拒绝且不写任何文件', () => {
    const root = makeProjectRoot('broken')
    const proferDir = join(root, '.profer')
    mkdirSync(proferDir, { recursive: true })
    writeFileSync(join(proferDir, 'profer.json'), '{ not json', 'utf-8')

    expect(() => openProjectWorkspace({ rootPath: root })).toThrow('项目清单格式损坏')
    expect(readFileSync(join(proferDir, 'profer.json'), 'utf-8')).toBe('{ not json')
    expect(existsSync(join(proferDir, 'mcp.json'))).toBe(false)
    expect(listAgentWorkspaces()).toHaveLength(0)
  })
})

describe('移除项目工作区', () => {
  test('Given project 工作区含会话 When 移除 Then 索引消失、项目与 .profer 完整、会话保留', () => {
    const root = makeProjectRoot('remove-me')
    const created = createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
    const canonicalRoot = realpathSync(root)

    const messagesPath = join(configRoot, 'agent-sessions', 'sess-1.jsonl')
    mkdirSync(join(configRoot, 'agent-sessions'), { recursive: true })
    writeFileSync(messagesPath, '{"type":"user"}\n', 'utf-8')
    const sessionsIndex = {
      sessions: [{ id: 'sess-1', title: 'project session', workspaceId: created.workspace.id, createdAt: 1, updatedAt: 1 }],
    }
    writeFileSync(sessionsIndexPath, `${JSON.stringify(sessionsIndex, null, 2)}\n`, 'utf-8')

    removeProjectWorkspace(created.workspace.id)

    expect(listAgentWorkspaces()).toHaveLength(0)
    expect(readIndexFile().workspaces).toHaveLength(0)
    expect(readFileSync(indexPath, 'utf-8')).not.toContain(created.workspace.slug)

    expect(existsSync(join(canonicalRoot, 'package.json'))).toBe(true)
    expect(existsSync(join(canonicalRoot, '.profer', 'mcp.json'))).toBe(true)
    expect(existsSync(join(canonicalRoot, '.profer', 'profer.json'))).toBe(true)

    expect(readFileSync(sessionsIndexPath, 'utf-8')).toBe(`${JSON.stringify(sessionsIndex, null, 2)}\n`)
    expect(existsSync(messagesPath)).toBe(true)
  })

  test('Given 只剩一个 project When 移除 Then 允许（项目是外部资产）', () => {
    const root = makeProjectRoot('only-project')
    const created = createProjectWorkspace({ rootPath: root, proferVersion: '0.16.17' })
    expect(listAgentWorkspaces()).toHaveLength(1)

    expect(() => removeProjectWorkspace(created.workspace.id)).not.toThrow()
    expect(listAgentWorkspaces()).toHaveLength(0)
  })

  test('Given managed 工作区 When 按项目移除 Then 拒绝且不删索引', () => {
    // 直接写一条 managed 索引：removeProjectWorkspace 必须拒绝，不能把托管目录误当项目
    mkdirSync(configRoot, { recursive: true })
    writeFileSync(indexPath, JSON.stringify({
      version: 4,
      workspaces: [{ id: 'id-managed', name: '默认', slug: 'default', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }],
    }, null, 2), 'utf-8')
    invalidateWorkspaceLocation()

    expect(() => removeProjectWorkspace('id-managed')).toThrow('不是项目模式工作区')
    expect(listAgentWorkspaces()).toHaveLength(1)
  })
})

describe('重新定位项目工作区', () => {
  test('Given 目录被移动 When 重新定位 Then 保留 id/slug 只换 rootPath，会话归属不断', () => {
    const oldRoot = makeProjectRoot('relocate-old')
    const created = createProjectWorkspace({ rootPath: oldRoot, proferVersion: '0.16.17' })
    const newRoot = makeProjectRoot('relocate-new')

    const result = relocateProjectWorkspace({ id: created.workspace.id, rootPath: newRoot, proferVersion: '0.16.17' })

    expect(result.created).toBe(false)
    expect(result.workspace.id).toBe(created.workspace.id)
    expect(result.workspace.slug).toBe(created.workspace.slug)
    expect(result.workspace.rootPath).toBe(realpathSync(newRoot))
    expect(result.workspace.storageMode).toBe('project')
    // 新目录补齐骨架；旧目录完全不动
    expect(existsSync(join(realpathSync(newRoot), '.profer', 'profer.json'))).toBe(true)
    expect(existsSync(join(realpathSync(oldRoot), '.profer', 'profer.json'))).toBe(true)

    const listed = listAgentWorkspaces()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(created.workspace.id)
    expect(listed[0]!.rootPath).toBe(realpathSync(newRoot))
  })

  test('Given 新目录已绑定其他项目 When 重新定位 Then 拒绝，不产生双绑定', () => {
    const rootA = makeProjectRoot('relocate-a')
    const rootB = makeProjectRoot('relocate-b')
    const a = createProjectWorkspace({ rootPath: rootA, proferVersion: '0.16.17' })
    const b = createProjectWorkspace({ rootPath: rootB, proferVersion: '0.16.17' })

    expect(() => relocateProjectWorkspace({ id: a.workspace.id, rootPath: rootB, proferVersion: '0.16.17' }))
      .toThrow('已绑定为项目')
    expect(listAgentWorkspaces()).toHaveLength(2)
    expect(listAgentWorkspaces().find((workspace) => workspace.id === b.workspace.id)?.rootPath).toBe(realpathSync(rootB))
  })

  test('Given 索引里的项目缺 rootPath（降级）When 重新定位 Then 恢复绑定并清除降级标记', () => {
    // 模拟索引损坏：storageMode=project 但 rootPath 丢失（UI 据此显示「重新定位」）
    mkdirSync(configRoot, { recursive: true })
    writeFileSync(indexPath, JSON.stringify({
      version: 4,
      workspaces: [{ id: 'ws-degraded', name: '丢失项目', slug: 'ws-degraded', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project' }],
    }, null, 2), 'utf-8')
    invalidateWorkspaceLocation()

    const degraded = listAgentWorkspaces().find((workspace) => workspace.id === 'ws-degraded')
    expect(degraded?.rootPath).toBeUndefined()

    const newRoot = makeProjectRoot('relocate-degraded-new')
    const result = relocateProjectWorkspace({ id: 'ws-degraded', rootPath: newRoot, proferVersion: '0.16.17' })

    expect(result.workspace.id).toBe('ws-degraded')
    expect(result.workspace.slug).toBe('ws-degraded')
    expect(result.workspace.rootPath).toBe(realpathSync(newRoot))
  })
})
