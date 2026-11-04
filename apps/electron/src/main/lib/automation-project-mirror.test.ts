/**
 * P3：工作区定时任务镜像
 *
 * - 绑定 project 工作区的任务写入 `<root>/.profer/automations.json`；
 * - 无工作区 / managed 任务不进入项目文件；
 * - 项目文件里的任务在启动时合并回全局（项目拷来即可恢复）。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  View: {},
  WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-automations-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  createAutomation,
  listAutomations,
  updateAutomation,
  __resetAutomationManagerForTests,
} = await import('./automation-manager')
const { projectAutomationsPath } = await import('./project-automation-store')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const automationsPath = join(configRoot, 'automations.json')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [indexPath, automationsPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  __resetAutomationManagerForTests()
  invalidateWorkspaceLocation()
})

function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(join(root, '.profer'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# project\n', 'utf-8')
  return realpathSync(root)
}

function writeWorkspaces(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function projectEntry(slug: string, rootPath: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

function managedEntry(slug: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function readProjectFile(root: string): { automations: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(projectAutomationsPath(root), 'utf-8')) as { automations: Array<Record<string, unknown>> }
}

function createTask(workspaceId: string | undefined, name: string) {
  return createAutomation({
    name,
    prompt: 'do something',
    scheduleType: 'interval',
    intervalMinutes: 60,
    channelId: 'channel-1',
    workspaceId,
    active: false,
  })
}

describe('项目定时任务镜像', () => {
  test('Given 绑定 project 的任务 When 创建 Then 项目文件包含它，全局索引也保留', () => {
    const root = makeProject('p1')
    writeWorkspaces([projectEntry('p1', root), managedEntry('default')])

    const task = createTask('id-p1', 'project task')

    expect(existsSync(projectAutomationsPath(root))).toBe(true)
    expect(readProjectFile(root).automations.map((item) => item.id)).toEqual([task.id])

    const global = JSON.parse(readFileSync(automationsPath, 'utf-8')) as { automations: Array<Record<string, unknown>> }
    expect(global.automations.map((item) => item.id)).toContain(task.id)
  })

  test('Given 无工作区任务 When 创建 Then 不进入任何项目文件', () => {
    const root = makeProject('p2')
    writeWorkspaces([projectEntry('p2', root), managedEntry('default')])

    createTask(undefined, 'global task')

    // 项目镜像会被写成空列表（保证删除最后一个任务时能清空旧副本），但不能包含全局任务
    expect(readProjectFile(root).automations).toEqual([])
  })

  test('Given 项目文件里有全局未知的任务 When 读取 Then 合并回全局并修正工作区', () => {
    const root = makeProject('imported')
    writeWorkspaces([projectEntry('imported', root), managedEntry('default')])
    writeFileSync(projectAutomationsPath(root), JSON.stringify({
      version: 1,
      automations: [{
        id: 'imported-task',
        name: 'from another machine',
        prompt: 'run',
        active: false,
        scheduleType: 'interval',
        intervalMinutes: 30,
        channelId: 'channel-1',
        workspaceId: 'stale-id',
        permissionMode: 'bypassPermissions',
        createdAt: 10,
        updatedAt: 20,
      }],
      triggers: [],
    }), 'utf-8')

    const task = listAutomations().find((item) => item.id === 'imported-task')
    expect(task).toBeDefined()
    expect(task?.workspaceId).toBe('id-imported')
  })

  test('Given 任务从项目 A 改绑到项目 B When 更新 Then A 文件移除、B 文件出现', () => {
    const rootA = makeProject('a')
    const rootB = makeProject('b')
    writeWorkspaces([projectEntry('a', rootA), projectEntry('b', rootB), managedEntry('default')])

    const task = createTask('id-a', 'move task')
    expect(readProjectFile(rootA).automations.map((item) => item.id)).toContain(task.id)

    updateAutomation({ id: task.id, workspaceId: 'id-b' })

    expect(readProjectFile(rootA).automations.map((item) => item.id)).not.toContain(task.id)
    expect(readProjectFile(rootB).automations.map((item) => item.id)).toContain(task.id)
  })
})
