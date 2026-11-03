/**
 * 工作区索引 v4 迁移与写入校验（A1 安全底座）
 *
 * 覆盖三件事：
 * - v3 → v4：存量条目补 `storageMode: 'managed'`，不落盘 `rootPath`
 * - 损坏索引：归一化永不 throw（workspaces 非数组、JSON 非法）
 * - 写入校验：project 必须有绝对 rootPath、managed 不得有 rootPath、rootPath 归一化后唯一（I5）
 *
 * 环境隔离方式与 agent-workspace-archive.test.ts 一致：mock electron + 临时配置根。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

const configRoot = join(tmpdir(), `profer-workspace-index-v4-${Date.now()}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { createAgentWorkspace, readIndex, writeIndex } = await import('./agent-workspace-manager')
const { getAgentWorkspacesIndexPath } = await import('./config-paths')
const { resolveWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(indexPath, { recursive: true, force: true })
  rmSync(`${indexPath}.bak`, { force: true })
  rmSync(`${indexPath}.tmp`, { force: true })
})

function writeRawIndex(content: unknown): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8')
}

function readIndexFile(): { version: number; workspaces: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(indexPath, 'utf-8'))
}

function projectWorkspace(slug: string, rootPath: string): Record<string, unknown> {
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

describe('索引 v3 → v4 迁移', () => {
  test('Given v3 索引 When 读取 Then 补齐 storageMode=managed 并落盘为 v4', () => {
    writeRawIndex({
      version: 3,
      workspaces: [
        { id: '1', name: '默认工作区', slug: 'default', createdAt: 1, updatedAt: 1, type: 'personal' },
        { id: '2', name: '二号', slug: 'second', createdAt: 2, updatedAt: 2, type: 'personal' },
      ],
    })

    const index = readIndex()

    expect(index.version).toBe(4)
    expect(index.workspaces.map((w) => w.storageMode)).toEqual(['managed', 'managed'])
    expect(index.workspaces.every((w) => w.rootPath === undefined)).toBe(true)

    const onDisk = readIndexFile()
    expect(onDisk.version).toBe(4)
    expect(onDisk.workspaces.map((w) => w.storageMode)).toEqual(['managed', 'managed'])
    expect(onDisk.workspaces.every((w) => !('rootPath' in w))).toBe(true)
  })

  test('Given v4 索引条目缺 storageMode When 读取 Then 按 managed 解释且不报错', () => {
    writeRawIndex({ version: 4, workspaces: [{ id: '3', name: '旧字段', slug: 'legacy', createdAt: 1, updatedAt: 1 }] })

    const index = readIndex()
    expect(index.workspaces[0]?.storageMode).toBe('managed')
  })
})

describe('损坏索引容错（永不 throw）', () => {
  test('Given workspaces 不是数组 When 读取 Then 回退为空列表', () => {
    writeRawIndex({ version: 4, workspaces: { slug: 'oops' } })

    expect(() => readIndex()).not.toThrow()
    expect(readIndex()).toEqual({ version: 4, workspaces: [] })
  })

  test('Given 索引文件不是合法 JSON When 读取 Then 回退为空列表', () => {
    writeRawIndex('{ this is not json')

    expect(() => readIndex()).not.toThrow()
    expect(readIndex().workspaces).toEqual([])
  })

  test('Given 条目含非对象元素 When 读取 Then 跳过坏元素保留好元素', () => {
    writeRawIndex({
      version: 4,
      workspaces: [null, 'x', { id: '4', name: '好的', slug: 'good', createdAt: 1, updatedAt: 1 }],
    })

    const index = readIndex()
    expect(index.workspaces).toHaveLength(1)
    expect(index.workspaces[0]?.slug).toBe('good')
  })
})

describe('writeIndex 校验（I5）', () => {
  test('Given 两个 project 工作区指向同一 rootPath When 写入 Then 拒绝', () => {
    const projectDir = join(configRoot, 'dup-project')
    mkdirSync(projectDir, { recursive: true })

    expect(() => writeIndex({
      version: 4,
      workspaces: [projectWorkspace('a', projectDir), projectWorkspace('b', projectDir)] as never,
    })).toThrow(/项目目录已被其他工作区使用/)
  })

  test('Given 两个 project 经符号链接指向同一真实目录 When 写入 Then 仍判为重复', () => {
    const projectDir = join(configRoot, 'real-project')
    const linkDir = join(configRoot, 'link-project')
    mkdirSync(projectDir, { recursive: true })
    symlinkSync(projectDir, linkDir)

    expect(() => writeIndex({
      version: 4,
      workspaces: [projectWorkspace('c', projectDir), projectWorkspace('d', linkDir)] as never,
    })).toThrow(/项目目录已被其他工作区使用/)
  })

  test('Given project 缺 rootPath When 写入 Then 拒绝', () => {
    expect(() => writeIndex({
      version: 4,
      workspaces: [{ id: '5', name: '无根', slug: 'no-root', createdAt: 1, updatedAt: 1, storageMode: 'project' }] as never,
    })).toThrow(/必须有绝对 rootPath/)
  })

  test('Given project 使用相对 rootPath When 写入 Then 拒绝', () => {
    expect(() => writeIndex({
      version: 4,
      workspaces: [projectWorkspace('e', './relative-project')] as never,
    })).toThrow(/必须有绝对 rootPath/)
  })

  test('Given managed 工作区带 rootPath When 写入 Then 拒绝', () => {
    expect(() => writeIndex({
      version: 4,
      workspaces: [{ id: '6', name: 'managed', slug: 'managed-ws', createdAt: 1, updatedAt: 1, storageMode: 'managed', rootPath: '/tmp/x' }] as never,
    })).toThrow(/不得包含 rootPath/)
  })

  test('Given 合法 project When 写入 Then rootPath 归一化后落盘', () => {
    const projectDir = join(configRoot, 'normalized-project')
    mkdirSync(projectDir, { recursive: true })
    const messyPath = join(configRoot, 'normalized-project', '..', 'normalized-project')

    writeIndex({ version: 4, workspaces: [projectWorkspace('f', messyPath)] as never })

    const onDisk = readIndexFile()
    expect(onDisk.workspaces[0]?.rootPath).toBe(realpathSync(projectDir))
    expect(onDisk.workspaces[0]?.rootPath).not.toContain('..')
  })

  test('Given rootPath 尚不存在 When 写入 Then 用 resolve 归一化且不创建目录', () => {
    const futureRoot = join(configRoot, 'future-project', '..', 'future-project')

    writeIndex({ version: 4, workspaces: [projectWorkspace('g', futureRoot)] as never })

    expect(readIndexFile().workspaces[0]?.rootPath).toBe(resolve(futureRoot))
    expect(existsSync(join(configRoot, 'future-project'))).toBe(false)
  })
})

describe('create 后 locator 立即可解析（缓存失效接线）', () => {
  test('Given 新建 managed 工作区 When 解析位置 Then 与索引中的 slug 对齐', () => {
    writeRawIndex({ version: 4, workspaces: [] })

    const workspace = createAgentWorkspace('缓存接线')
    const location = resolveWorkspaceLocation(workspace.slug)

    expect(location.mode).toBe('managed')
    expect(location.configDir).toBe(join(configRoot, 'agent-workspaces', workspace.slug))
    expect(getAgentWorkspacesIndexPath()).toBe(indexPath)
  })
})
