/**
 * P1-C：`mcp.local.json` 本机覆盖层（只读合并）
 *
 * 锁住实现规格 §2.6 / 验收 A15：
 * - project：`<root>/.profer/mcp.json` 之上叠加 `mcp.local.json`——同名 server 的
 *   env / headers 键级合并、标量字段 local 覆盖；只存在于 local 的 server 也生效。
 * - 缺 `mcp.local.json` 时行为与改造前逐字一致（不做任何多余写入）。
 * - managed：不读 local（I1，存量行为不变）。
 * - local 内容永不写回 `mcp.json`（含「读 → 改 → 写」链路）。
 * - local 损坏不炸运行时，退化为 base。
 *
 * 环境隔离方式与 agent-workspace-manager.index-v4.test.ts 一致：临时配置根 + 真实索引文件。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceMcpConfig } from '@profer/shared'

process.env.PROFER_DEV = '1'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-mcp-local-'))
const configRoot = join(sandbox, 'config')
const projectRoot = join(sandbox, 'project')
const managedRoot = join(configRoot, 'agent-workspaces', 'ws-managed')
const indexPath = join(configRoot, 'agent-workspaces.json')

process.env.PROFER_CONFIG_DIR = configRoot

const { getWorkspaceMcpConfig } = await import('./workspace-mcp-config')
// 读取走窄入口（生产链路一致），写入是 manager 的导出，同样在 P1-C 范围内
const { saveWorkspaceMcpConfig } = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const PROJECT_SLUG = 'ws-project'

function writeIndex(): void {
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(indexPath, JSON.stringify({
    version: 4,
    workspaces: [
      {
        id: 'id-project',
        name: '项目夹具',
        slug: PROJECT_SLUG,
        createdAt: 1,
        updatedAt: 1,
        type: 'personal',
        storageMode: 'project',
        rootPath: realpathSync(projectRoot),
      },
      {
        id: 'id-managed',
        name: '存量夹具',
        slug: 'ws-managed',
        createdAt: 1,
        updatedAt: 1,
        type: 'personal',
      },
    ],
  }), 'utf-8')
  invalidateWorkspaceLocation()
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

/** 期望值用 JSON 归一化后的字面量比较，避免结构化类型与 Record 的字面量推断差异。 */
function plain<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value))
}

const projectMcpPath = () => join(projectRoot, '.profer', 'mcp.json')
const projectLocalPath = () => join(projectRoot, '.profer', 'mcp.local.json')

const BASE_MCP: WorkspaceMcpConfig = {
  servers: {
    api: {
      type: 'http',
      url: 'https://api.example.com/mcp',
      headers: {
        Authorization: '${env:PROFER_API_TOKEN}',
        'X-Team': 'shared',
      },
      enabled: true,
    },
    'base-only': {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'base-only-mcp'],
      env: { SHARED: 'base' },
      enabled: true,
    },
  },
}

beforeEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
  rmSync(managedRoot, { recursive: true, force: true })
  rmSync(indexPath, { force: true })
  mkdirSync(join(projectRoot, '.profer'), { recursive: true })
  writeJson(projectMcpPath(), BASE_MCP)
  writeIndex()
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
  delete process.env.PROFER_CONFIG_DIR
})

describe('project：mcp.local.json 覆盖 mcp.json', () => {
  test('同名 server 的 env / headers 键级合并，标量字段 local 覆盖，base 其余 server 保留', () => {
    writeJson(projectLocalPath(), {
      servers: {
        api: {
          headers: { Authorization: 'Bearer local-secret' },
          url: 'https://local.example.com/mcp',
        },
        'base-only': {
          env: { SHARED: 'local', LOCAL_ONLY_KEY: 'v' },
        },
        'local-tool': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'local-tool'],
          env: { LOCAL_KEY: 'secret' },
          enabled: true,
        },
      },
    })

    const config = getWorkspaceMcpConfig(PROJECT_SLUG)

    // local 覆盖 headers 的一个键，base 的其它键仍在
    expect(config.servers.api!.headers).toEqual({
      Authorization: 'Bearer local-secret',
      'X-Team': 'shared',
    })
    expect(config.servers.api!.url).toBe('https://local.example.com/mcp')
    expect(config.servers.api!.enabled).toBe(true)

    // env 键级合并（保留 base 键，新增 local 键）
    expect(config.servers['base-only']!.env).toEqual({ SHARED: 'local', LOCAL_ONLY_KEY: 'v' })
    expect(config.servers['base-only']!.command).toBe('npx')

    // 只存在于 local 的 server 也生效
    expect(config.servers['local-tool']!.command).toBe('npx')
    expect(config.servers['local-tool']!.env).toEqual({ LOCAL_KEY: 'secret' })

    // 只读：不得凭空造出 local 文件、不得改写 base 文件
    expect(plain(readJson(projectMcpPath()))).toEqual(plain(BASE_MCP))
    expect(existsSync(projectLocalPath())).toBe(true)
  })

  test('local 只覆盖 headers 时不改变推断出的传输类型（http 保持 http）', () => {
    writeJson(projectMcpPath(), {
      servers: {
        api: { url: 'https://api.example.com/mcp', headers: { 'X-Team': 'shared' }, enabled: true },
      },
    })
    writeJson(projectLocalPath(), {
      servers: { api: { headers: { Authorization: 'Bearer local-secret' } } },
    })

    const config = getWorkspaceMcpConfig(PROJECT_SLUG)
    expect(config.servers.api!.type).toBe('http')
    expect(config.servers.api!.headers).toEqual({
      'X-Team': 'shared',
      Authorization: 'Bearer local-secret',
    })
  })

  test('没有 mcp.local.json 时与 base 逐字一致', () => {
    const config = getWorkspaceMcpConfig(PROJECT_SLUG)

    expect(config).toEqual(BASE_MCP)
    expect(existsSync(projectLocalPath())).toBe(false)
  })

  test('mcp.local.json 损坏时退化为 base，不抛错', () => {
    writeFileSync(projectLocalPath(), '{ this is not json', 'utf-8')

    const config = getWorkspaceMcpConfig(PROJECT_SLUG)
    expect(config).toEqual(BASE_MCP)
  })

  test('读改写链路（保存）不会把 local 内容写回 mcp.json', () => {
    writeJson(projectLocalPath(), {
      servers: {
        api: { headers: { Authorization: 'Bearer local-secret' } },
        'local-tool': { type: 'stdio', command: 'npx', args: ['-y', 'local-tool'], env: { LOCAL_KEY: 'secret' }, enabled: true },
      },
    })

    // 模拟 UI / lark-mcp 的「读 → 改 → 写」：拿到生效视图后改一个开关再保存
    const effective = getWorkspaceMcpConfig(PROJECT_SLUG)
    effective.servers.api!.enabled = false
    saveWorkspaceMcpConfig(PROJECT_SLUG, effective)

    const written = readJson(projectMcpPath()) as { servers: Record<string, Record<string, unknown>> }
    // 开关被保留
    expect(written.servers.api!.enabled).toBe(false)
    // local 的密钥回退成 base 的占位符，未落进受版本控制的文件
    expect((written.servers.api!.headers as Record<string, string>).Authorization).toBe('${env:PROFER_API_TOKEN}')
    expect(JSON.stringify(written)).not.toContain('local-secret')
    // local-only server 不落盘
    expect(written.servers['local-tool']).toBeUndefined()
    // 未受 local 影响的 server 原样保留
    expect(plain(written.servers['base-only'])).toEqual(plain(BASE_MCP.servers['base-only']))

    // local 文件本身不被改写
    const local = readJson(projectLocalPath()) as { servers: Record<string, unknown> }
    expect(local.servers['local-tool']).toBeDefined()
  })
})

describe('managed：行为不变（不读 local）', () => {
  test('managed 工作区忽略 mcp.local.json，保存也不读取它', () => {
    const managedMcpPath = join(managedRoot, 'mcp.json')
    const managedLocalPath = join(managedRoot, 'mcp.local.json')
    writeJson(managedMcpPath, { servers: { api: { type: 'http', url: 'https://m.example.com', enabled: true } } })
    writeJson(managedLocalPath, { servers: { api: { url: 'https://local.example.com' }, extra: { type: 'stdio', command: 'x', enabled: true } } })

    const config = getWorkspaceMcpConfig('ws-managed')
    expect(config.servers.api!.url).toBe('https://m.example.com')
    expect(config.servers.extra).toBeUndefined()

    saveWorkspaceMcpConfig('ws-managed', config)
    const written = readJson(managedMcpPath)
    expect(written).toEqual({ servers: { api: { type: 'http', url: 'https://m.example.com', enabled: true } } })
    // managed 的 local 文件保持原样（工具没读也没写）
    expect((readJson(managedLocalPath) as { servers: Record<string, unknown> }).servers.extra).toBeDefined()
  })

  test('managed 缺 mcp.json 时返回空 servers（存量行为）', () => {
    expect(getWorkspaceMcpConfig('ws-managed')).toEqual({ servers: {} })
  })
})
