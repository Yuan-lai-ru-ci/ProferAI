/**
 * MCP 测试结果落盘位置（M1）
 *
 * 规格：`lastTestResult` 是「这台机器上次探测到的结果」，属于本机状态。
 * - project 工作区：写 `mcp.local.json`，受版本控制的 `mcp.json` 保持干净；
 * - managed 工作区：没有 local 层，写回 `mcp.json`；
 * - server 在两层都不存在：不创建幽灵条目。
 *
 * 环境隔离方式与 workspace-mcp-config.project-local.test.ts 一致。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceMcpConfig } from '@profer/shared'

process.env.PROFER_DEV = '1'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-mcp-test-result-'))
const configRoot = join(sandbox, 'config')
const projectRoot = join(sandbox, 'project')
const managedRoot = join(configRoot, 'agent-workspaces', 'ws-managed')
const indexPath = join(configRoot, 'agent-workspaces.json')

process.env.PROFER_CONFIG_DIR = configRoot

const { saveMcpServerTestResult } = await import('./agent-workspace-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const PROJECT_SLUG = 'ws-project'
const MANAGED_SLUG = 'ws-managed'

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
        slug: MANAGED_SLUG,
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

function readJson(filePath: string): { servers?: Record<string, { lastTestResult?: unknown }> } {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as { servers?: Record<string, { lastTestResult?: unknown }> }
}

const projectMcpPath = (): string => join(projectRoot, '.profer', 'mcp.json')
const projectLocalPath = (): string => join(projectRoot, '.profer', 'mcp.local.json')
const managedMcpPath = (): string => join(managedRoot, 'mcp.json')

const BASE_MCP: WorkspaceMcpConfig = {
  servers: {
    api: { type: 'http', url: 'https://api.example.com/mcp', enabled: true },
    'base-only': { type: 'stdio', command: 'npx', args: ['-y', 'base-only-mcp'], enabled: true },
  },
}

const RESULT = {
  success: true,
  message: '连接成功，发现 2 个工具',
  timestamp: 1_790_000_000_000,
  fingerprint: 'abc123',
  tools: [{ name: 'list_projects', readOnly: true }],
}

beforeEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
  rmSync(managedRoot, { recursive: true, force: true })
  rmSync(indexPath, { force: true })
  mkdirSync(join(projectRoot, '.profer'), { recursive: true })
  writeJson(projectMcpPath(), BASE_MCP)
  writeJson(managedMcpPath(), BASE_MCP)
  writeIndex()
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
  delete process.env.PROFER_CONFIG_DIR
})

describe('project 工作区：测试结果写本机层', () => {
  test('结果写进 mcp.local.json，受版本控制的 mcp.json 不被弄脏', () => {
    const written = saveMcpServerTestResult(PROJECT_SLUG, 'api', RESULT)

    expect(written).toBe(true)
    expect(readJson(projectLocalPath()).servers?.api?.lastTestResult).toEqual(RESULT)
    expect(readJson(projectMcpPath()).servers?.api?.lastTestResult).toBeUndefined()
  })

  test('local 独有的 server 也能落盘（不因 base 缺失而丢弃）', () => {
    writeJson(projectLocalPath(), {
      servers: { localOnly: { type: 'stdio', command: 'npx', args: ['-y', 'local-only'], enabled: true } },
    })

    expect(saveMcpServerTestResult(PROJECT_SLUG, 'localOnly', RESULT)).toBe(true)
    expect(readJson(projectLocalPath()).servers?.localOnly?.lastTestResult).toEqual(RESULT)
    expect(readJson(projectMcpPath()).servers?.localOnly).toBeUndefined()
  })

  test('base 里的其他 server 不被 local 写入覆盖丢失', () => {
    saveMcpServerTestResult(PROJECT_SLUG, 'api', RESULT)

    expect(Object.keys(readJson(projectMcpPath()).servers ?? {}).sort()).toEqual(['api', 'base-only'])
    expect(Object.keys(readJson(projectLocalPath()).servers ?? {})).toEqual(['api'])
  })
})

describe('managed 工作区：没有 local 层', () => {
  test('结果直接写回 mcp.json', () => {
    expect(saveMcpServerTestResult(MANAGED_SLUG, 'base-only', RESULT)).toBe(true)
    expect(readJson(managedMcpPath()).servers?.['base-only']?.lastTestResult).toEqual(RESULT)
  })
})

describe('边界', () => {
  test('server 不存在时不创建条目，返回 false', () => {
    expect(saveMcpServerTestResult(PROJECT_SLUG, 'ghost', RESULT)).toBe(false)
    expect(existsSync(projectLocalPath())).toBe(false)
    expect(readJson(projectMcpPath()).servers?.ghost).toBeUndefined()
  })
})
