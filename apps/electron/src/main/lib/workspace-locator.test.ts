/**
 * workspace-locator 单元测试
 *
 * 锁住 A1「安全底座」的四条硬约束：
 * - managed 缺省：路径与改造前一致（I1）
 * - project：configDir = <rootPath>/.profer，rootPath 经 realpath 归一化
 * - rootPath 不存在时不 mkdir、不创建，纯解析不留副作用（I4）
 * - 模块边界：locator 不得 import agent-workspace-manager / config-paths（否则成环）
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.PROFER_DEV = '1'

const {
  WorkspaceRootMissingError,
  getWorkspacesIndexPath,
  getWorkspacesRootPath,
  invalidateWorkspaceLocation,
  isProjectWorkspaceRootPath,
  requireExistingWorkspaceRoot,
  resolveWorkspaceLocation,
} = await import('./workspace-locator')

let root = ''
let configRoot = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-locator-'))
  configRoot = join(root, 'config')
  process.env.PROFER_CONFIG_DIR = configRoot
  // 模块级缓存跨用例存活，环境变了必须清空
  invalidateWorkspaceLocation()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PROFER_CONFIG_DIR
})

function writeIndexFile(workspaces: unknown[], version = 4): void {
  const indexPath = join(configRoot, 'agent-workspaces.json')
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version, workspaces }), 'utf-8')
}

describe('索引位置', () => {
  test('Given 配置根 When 解析索引路径 Then 与 config-paths 约定一致', () => {
    expect(getWorkspacesIndexPath()).toBe(join(configRoot, 'agent-workspaces.json'))
    expect(getWorkspacesRootPath()).toBe(join(configRoot, 'agent-workspaces'))
  })
})

describe('managed 模式', () => {
  test('Given 索引无该 slug When 解析 Then 按 managed 兜底且不创建目录', () => {
    const location = resolveWorkspaceLocation('ws-missing')

    expect(location).toEqual({
      configDir: join(configRoot, 'agent-workspaces', 'ws-missing'),
      rootPath: join(configRoot, 'agent-workspaces', 'ws-missing'),
      runtimeDir: join(configRoot, 'agent-workspaces', 'ws-missing'),
      mode: 'managed',
    })
    // 纯解析不得造目录（创建由 getAgentWorkspacePath 显式负责）
    expect(existsSync(location.configDir)).toBe(false)
  })

  test('Given v3 索引缺 storageMode When 解析 Then 视为 managed', () => {
    writeIndexFile([{ id: '1', name: '存量', slug: 'ws-legacy', createdAt: 1, updatedAt: 1 }], 3)

    const location = resolveWorkspaceLocation('ws-legacy')
    expect(location.mode).toBe('managed')
    expect(location.configDir).toBe(join(configRoot, 'agent-workspaces', 'ws-legacy'))
  })
})

describe('project 模式', () => {
  test('Given project 条目 When 解析 Then configDir 为 <rootPath>/.profer 且 rootPath 取 realpath', () => {
    const projectDir = join(root, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    writeIndexFile([{ id: '2', name: '项目', slug: 'ws-proj', createdAt: 1, updatedAt: 1, storageMode: 'project', rootPath: projectDir }])

    const location = resolveWorkspaceLocation('ws-proj')

    expect(location.mode).toBe('project')
    expect(location.rootPath).toBe(realpathSync(projectDir))
    expect(location.configDir).toBe(join(realpathSync(projectDir), '.profer'))
    // 解析不是写入：.profer 不能被凭空创建
    expect(existsSync(join(realpathSync(projectDir), '.profer'))).toBe(false)
  })

  test('Given project 条目缺 rootPath When 解析 Then 降级 managed 但带 degradedFromProject（P1-残留-2）', () => {
    writeIndexFile([{ id: '3', name: '坏数据', slug: 'ws-broken', createdAt: 1, updatedAt: 1, storageMode: 'project' }])

    const location = resolveWorkspaceLocation('ws-broken')
    // 位置只能按 managed 解释（绝不能猜项目根），但必须显式标记降级：
    // 否则删除入口会把它当成普通托管工作区，级联删掉项目会话历史。
    expect(location.mode).toBe('managed')
    expect(location.configDir).toBe(join(configRoot, 'agent-workspaces', 'ws-broken'))
    expect(location.degradedFromProject).toBe(true)
  })

  test('Given 正常 managed 条目 When 解析 Then 不带 degradedFromProject', () => {
    writeIndexFile([{ id: '3b', name: '托管', slug: 'ws-managed', createdAt: 1, updatedAt: 1, storageMode: 'managed' }])

    expect(resolveWorkspaceLocation('ws-managed').degradedFromProject).toBeUndefined()
  })

  test('Given 条目带降级标记（storageMode 已被洗成 managed）When 解析 Then 仍带 degradedFromProject', () => {
    writeIndexFile([{ id: '3c', name: '降级', slug: 'ws-degraded', createdAt: 1, updatedAt: 1, storageMode: 'managed', degradedFromProject: true }])

    expect(resolveWorkspaceLocation('ws-degraded').degradedFromProject).toBe(true)
  })

  test('Given 条目缺 storageMode 但有绝对 rootPath When 解析 Then 视为 project（P1-5）', () => {
    const projectDir = join(root, 'corrupt-project')
    mkdirSync(projectDir, { recursive: true })
    writeIndexFile([{ id: '7', name: '损坏条目', slug: 'ws-corrupt', createdAt: 1, updatedAt: 1, rootPath: projectDir }])

    const location = resolveWorkspaceLocation('ws-corrupt')

    // 索引损坏时降级 managed 会把「移除」变成级联删会话：合法 rootPath 即 project
    expect(location.mode).toBe('project')
    expect(location.rootPath).toBe(realpathSync(projectDir))
    expect(location.configDir).toBe(join(realpathSync(projectDir), '.profer'))
    expect(location.runtimeDir).toBe(join(configRoot, 'agent-workspaces', 'ws-corrupt'))
  })

  test('Given 条目 storageMode 非法但有绝对 rootPath When 解析 Then 视为 project（P1-5）', () => {
    const projectDir = join(root, 'bad-mode-project')
    mkdirSync(projectDir, { recursive: true })
    writeIndexFile([{ id: '8', name: '非法模式', slug: 'ws-bad-mode', createdAt: 1, updatedAt: 1, storageMode: 'projcet', rootPath: projectDir }])

    expect(resolveWorkspaceLocation('ws-bad-mode').mode).toBe('project')
  })

  test('Given project 条目 rootPath 为相对路径 When 解析 Then 降级 managed', () => {
    writeIndexFile([{ id: '4', name: '相对路径', slug: 'ws-relative', createdAt: 1, updatedAt: 1, storageMode: 'project', rootPath: './x' }])

    expect(resolveWorkspaceLocation('ws-relative').mode).toBe('managed')
  })

  test('Given rootPath 已消失 When 校验根目录 Then 抛 WorkspaceRootMissingError 且不创建任何目录', () => {
    const missingRoot = join(root, 'gone-project')
    writeIndexFile([{ id: '5', name: '已删除', slug: 'ws-gone', createdAt: 1, updatedAt: 1, storageMode: 'project', rootPath: missingRoot }])

    const location = resolveWorkspaceLocation('ws-gone')
    expect(() => requireExistingWorkspaceRoot(location)).toThrow(WorkspaceRootMissingError)
    expect(existsSync(missingRoot)).toBe(false)
    expect(existsSync(join(missingRoot, '.profer'))).toBe(false)
  })
})

describe('isProjectWorkspaceRootPath（桌面 @ 搜索的 project 判定）', () => {
  test('Given project 条目 When 用项目根判断 Then true；无关路径与 managed 目录为 false', () => {
    const projectDir = join(root, 'search-project')
    mkdirSync(projectDir, { recursive: true })
    writeIndexFile([
      { id: 'p1', name: '项目', slug: 'ws-search-p', createdAt: 1, updatedAt: 1, storageMode: 'project', rootPath: projectDir },
      { id: 'm1', name: '托管', slug: 'ws-search-m', createdAt: 1, updatedAt: 1, storageMode: 'managed' },
    ])

    expect(isProjectWorkspaceRootPath(projectDir)).toBe(true)
    expect(isProjectWorkspaceRootPath(realpathSync(projectDir))).toBe(true)
    expect(isProjectWorkspaceRootPath(join(projectDir, 'src'))).toBe(false)
    expect(isProjectWorkspaceRootPath(join(configRoot, 'agent-workspaces', 'ws-search-m'))).toBe(false)
    expect(isProjectWorkspaceRootPath('./relative')).toBe(false)
  })

  test('Given project 条目缺 rootPath（降级）When 判断 Then false（没有可剪枝的项目根）', () => {
    writeIndexFile([{ id: 'p2', name: '坏项目', slug: 'ws-search-broken', createdAt: 1, updatedAt: 1, storageMode: 'project' }])

    expect(isProjectWorkspaceRootPath(join(root, 'anything'))).toBe(false)
  })
})

describe('缓存与失效', () => {
  test('Given 索引不变 When 重复解析 Then 命中同一缓存对象', () => {
    writeIndexFile([{ id: '6', name: '缓存', slug: 'ws-cache', createdAt: 1, updatedAt: 1 }])

    const first = resolveWorkspaceLocation('ws-cache')
    const second = resolveWorkspaceLocation('ws-cache')

    expect(second).toBe(first)
  })

  test('Given 显式 invalidate When 再解析 Then 重建对象（索引未变）', () => {
    writeIndexFile([{ id: '7', name: '失效', slug: 'ws-invalidate', createdAt: 1, updatedAt: 1 }])

    const first = resolveWorkspaceLocation('ws-invalidate')
    invalidateWorkspaceLocation('ws-invalidate')
    const second = resolveWorkspaceLocation('ws-invalidate')

    expect(second).not.toBe(first)
    expect(second.configDir).toBe(first.configDir)
  })

  test('Given 外部重写索引 When 再解析 Then 自动感知新内容（mtime/尺寸签名失效）', () => {
    writeIndexFile([{ id: '8', name: '外部写', slug: 'ws-external', createdAt: 1, updatedAt: 1 }])
    expect(resolveWorkspaceLocation('ws-external').mode).toBe('managed')

    const projectDir = join(root, 'external-project')
    mkdirSync(projectDir, { recursive: true })
    writeIndexFile([{ id: '8', name: '外部写', slug: 'ws-external', createdAt: 1, updatedAt: 2, storageMode: 'project', rootPath: projectDir }])

    const location = resolveWorkspaceLocation('ws-external')
    expect(location.mode).toBe('project')
    expect(location.rootPath).toBe(realpathSync(projectDir))
  })

  test('Given invalidate 全量 When 再解析 Then 所有条目重建', () => {
    writeIndexFile([
      { id: '9', name: 'A', slug: 'ws-a', createdAt: 1, updatedAt: 1 },
      { id: '10', name: 'B', slug: 'ws-b', createdAt: 1, updatedAt: 1 },
    ])

    const a1 = resolveWorkspaceLocation('ws-a')
    const b1 = resolveWorkspaceLocation('ws-b')
    invalidateWorkspaceLocation()

    expect(resolveWorkspaceLocation('ws-a')).not.toBe(a1)
    expect(resolveWorkspaceLocation('ws-b')).not.toBe(b1)
  })
})

describe('模块边界', () => {
  test('Given locator 源码 When 检查 import Then 不引用 manager 与 config-paths（避免成环）', () => {
    const source = readFileSync(join(import.meta.dir, 'workspace-locator.ts'), 'utf-8')

    expect(source).not.toContain("from './agent-workspace-manager'")
    expect(source).not.toContain("from './config-paths'")
  })
})
