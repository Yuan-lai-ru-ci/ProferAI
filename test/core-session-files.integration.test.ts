import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { AGENT_IPC_CHANNELS } from '../packages/shared/src/index'
import { CoreClient } from '../apps/electron/src/main/lib/core-client'
import { createCoreAgentRuntime } from '../apps/core/src/runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from '../apps/core/src/server'

// 执行真实注册函数和真实路由；不导入 Electron，也不重复实现业务分支。
const ipcSource = readFileSync(new URL('../apps/electron/src/main/ipc.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../apps/electron/src/main/lib/core-native-routing.ts', import.meta.url), 'utf8')
const transpiler = new Bun.Transpiler({ loader: 'ts' })
function registeredHandler(channel: keyof typeof AGENT_IPC_CHANNELS, deps: Record<string, unknown>) {
  const start = ipcSource.indexOf(`    AGENT_IPC_CHANNELS.${channel},`)
  const end = ipcSource.indexOf('\n  )', start)
  const code = transpiler.transformSync(`ipcMain.handle(\n${ipcSource.slice(start, end)}\n)`)
  let invoke: (...args: unknown[]) => Promise<unknown> = () => { throw new Error('IPC 未注册') }
  const values = { AGENT_IPC_CHANNELS, ...deps, ipcMain: { handle: (_channel: string, callback: typeof invoke) => { invoke = callback } } }
  new Function(...Object.keys(values), code)(...Object.values(values))
  return (...args: unknown[]) => invoke({}, ...args)
}
function shellAccess(configDir: string, captureCoreNativeRoute: unknown, local = true, openError = '') {
  const opened: string[] = [], revealed: string[] = []
  const values = {
    join, resolve, relative, isAbsolute, sep, realpathSync,
    getConfigDir: () => configDir,
    getAgentWorkspacesDir: () => join(configDir, 'agent-workspaces'),
    listProjectWorkspaceRoots: () => [],
    // 旧守卫项目根分支的既有依赖；本组 fixture 使用 managed。
    isPathInsideRoot: (path: string, root: string) => path === root || path.startsWith(root + sep),
    realpathOrResolve: (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } },
    captureCoreNativeRoute,
    assertLocalWorkspaceFiles: () => { if (!local) throw new Error('远程路径禁止进入本机 shell') },
    assertSensitiveAgentIpcSender: () => {},
    shell: { openPath: async (path: string) => { opened.push(path); return openError }, showItemInFolder: (path: string) => { revealed.push(path) } },
  }
  const start = ipcSource.indexOf('function isResolvedPathInsideRoot(')
  const end = ipcSource.indexOf('/**\n * 破坏性文件操作', start)
  const code = transpiler.transformSync(ipcSource.slice(start, end))
  // before 版本不含新 helper；旧 callback 自身仍完整执行，供历史失败复现。
  const functions = new Function(...Object.keys(values), `${code}\nreturn { assertInsideAgentWorkspaces, ...(typeof resolveAgentShellPath === 'function' ? { resolveAgentShellPath } : {}) }`)(...Object.values(values))
  const deps = { ...values, ...functions }
  return { opened, revealed, open: registeredHandler('OPEN_FILE', deps), reveal: registeredHandler('SHOW_IN_FOLDER', deps) }
}

function routes(client: CoreClient | null, remote = false) {
  let generation = 1
  const values = {
    getCurrentCoreTargetId: () => remote ? 'target-a' : 'local',
    currentCoreId: () => 'core-a', getLocalCoreClient: () => client, getActiveCoreClient: () => client,
    isLocalCoreEnabled: () => true, getCoreTargetGeneration: () => generation,
    parseCoreSessionId: (id: string) => {
      const match = /^core:([^:]+):(.+)$/.exec(id)
      return match ? { coreId: decodeURIComponent(match[1]!), sessionId: match[2]! } : null
    },
    namespaceCoreSessionId: (id: string, coreId: string) => `core:${encodeURIComponent(coreId)}:${id}`,
  }
  const start = routeSource.indexOf('export function captureCoreNativeRoute(')
  const end = routeSource.indexOf('export interface CoreNativeSnapshot')
  const code = transpiler.transformSync(routeSource.slice(start, end).replace('export function', 'function'))
  const captureCoreNativeRoute = new Function(...Object.keys(values), `${code}\nreturn captureCoreNativeRoute`)(...Object.values(values))
  const noLegacy = () => { throw new Error('不应访问 legacy 存储') }
  return {
    switchGeneration: () => { generation++ },
    deps: { captureCoreNativeRoute, assertSensitiveAgentIpcSender: () => {}, assertLocalWorkspaceFiles: noLegacy,
      resolveAgentSessionUiRootPath: noLegacy, resolveAgentSessionStoragePath: noLegacy, saveFilesToAgentSession: noLegacy },
  }
}

for (const remote of [false, true]) for (const project of [false, true]) {
  test(`Given ${remote ? '远程' : '本机'} Core/${project ? 'project' : 'managed'}，上传和产物列目录/读取/重命名同属工作台，且会话隔离`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-session-files-')))
    const config = { host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true }
    const runtime = createCoreAgentRuntime(config)
    const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const client = new CoreClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'fixture-only', reconnect: false })
    try {
      mkdirSync(join(root, 'project'))
      const workspace = project ? runtime.workspaces.bindProject({ rootPath: join(root, 'project') }).workspace : runtime.workspaces.createManaged('Files')
      const session = runtime.sessions.create({ workspaceId: workspace.id, title: 'files', runtime: 'pi' })
      const other = runtime.sessions.create({ workspaceId: workspace.id, title: 'other', runtime: 'claude' })
      const id = remote ? `core:core-a:${session.id}` : session.id
      const { deps } = routes(client, remote)
      const call = (channel: keyof typeof AGENT_IPC_CHANNELS, ...args: unknown[]) => registeredHandler(channel, deps)(...args)
      const roots = await call('CORE_SESSION_FILE_ROOTS', id) as { workbench: string; sessionStorage: string; workspaceRoot: string }
      expect(roots.workbench).toBe(join(config.configDir, 'session-workspaces', session.id))
      expect(roots.workbench).not.toBe(roots.sessionStorage)
      expect(await call('GET_SESSION_STORAGE_PATH', workspace.id, id)).toBe(roots.workbench)
      expect(await call('GET_SESSION_PATH', workspace.id, id)).toBe(project ? roots.workspaceRoot : roots.workbench)
      expect(await call('CORE_SESSION_LIST_DIRECTORY', { sessionId: id, path: roots.workbench })).toEqual([])
      const uploaded = await call('SAVE_FILES_TO_SESSION', { workspaceSlug: workspace.slug, sessionId: id,
        files: [{ filename: 'input.txt', data: Buffer.from('用户附件').toString('base64') }] }) as Array<{ filename: string; targetPath: string }>
      expect(uploaded).toHaveLength(1)
      expect(uploaded[0]!.targetPath.startsWith(join(roots.workbench, 'attachments') + '/')).toBe(true)
      expect(readFileSync(uploaded[0]!.targetPath, 'utf8')).toBe('用户附件')
      if (!remote) {
        const shell = shellAccess(config.configDir, deps.captureCoreNativeRoute)
        await shell.open(roots.workbench)
        await shell.open(uploaded[0]!.targetPath)
        await shell.reveal(uploaded[0]!.targetPath)
        expect(shell.opened).toEqual([roots.workbench, uploaded[0]!.targetPath])
        expect(shell.revealed).toEqual([uploaded[0]!.targetPath])
      }
      writeFileSync(join(roots.workbench, 'result.md'), '# Agent 产物')
      writeFileSync(join(roots.workbench, 'result.md'), '# Agent 产物')
      const entries = await call('CORE_SESSION_LIST_DIRECTORY', { sessionId: id, path: roots.workbench }) as Array<{ name: string }>
      expect(entries.map(item => item.name)).toContain('result.md')
      expect(entries.map(item => item.name)).toContain('attachments')
      const content = await client.readFile(session.id, join(roots.workbench, 'result.md'))
      expect(Buffer.from(content.base64, 'base64').toString()).toBe('# Agent 产物')
      await call('CORE_SESSION_FS_OP', { sessionId: id, op: 'rename', path: join(roots.workbench, 'result.md'), name: 'renamed.md' })
      expect(readFileSync(join(roots.workbench, 'renamed.md'), 'utf8')).toBe('# Agent 产物')
      const preview = await call('CORE_SESSION_FS_OP', { sessionId: id, op: 'preview', path: join(roots.workbench, 'renamed.md') }) as { base64: string }
      expect(Buffer.from(preview.base64, 'base64').toString()).toBe('# Agent 产物')
      mkdirSync(join(roots.workbench, 'copies'))
      await call('CORE_SESSION_FS_OP', { sessionId: id, op: 'copy', path: join(roots.workbench, 'renamed.md'), toDir: join(roots.workbench, 'copies') })
      await call('CORE_SESSION_FS_OP', { sessionId: id, op: 'move', path: join(roots.workbench, 'copies', 'renamed.md'), toDir: roots.workbench, overwrite: true })
      const trashed = await call('CORE_SESSION_FS_OP', { sessionId: id, op: 'trash', path: join(roots.workbench, 'renamed.md') }) as { path: string }
      expect(readFileSync(trashed.path, 'utf8')).toBe('# Agent 产物')
      writeFileSync(join(config.configDir, 'credential-fixture.json'), 'private')
      symlinkSync(join(config.configDir, 'credential-fixture.json'), join(roots.workbench, 'escape.json'))
      for (const path of [roots.workbench, config.configDir, join(config.configDir, 'credential-fixture.json'), join(roots.workbench, 'escape.json')]) {
        await expect(call('CORE_SESSION_FS_OP', { sessionId: id, op: 'trash', path })).rejects.toThrow()
      }
      expect(readFileSync(join(config.configDir, 'credential-fixture.json'), 'utf8')).toBe('private')
      // 系统文件入口不能借此例外操作任何 Core 内部工作台。
      expect(() => runtime.renameSystemEntry(uploaded[0]!.targetPath, 'system.txt')).toThrow()

      const otherId = remote ? `core:core-a:${other.id}` : other.id
      await expect(call('CORE_SESSION_LIST_DIRECTORY', { sessionId: otherId, path: roots.workbench })).rejects.toThrow()
      await expect(call('SAVE_FILES_TO_SESSION', { workspaceSlug: workspace.slug, sessionId: id,
        files: [{ filename: '../escape.txt', data: 'YQ==' }] })).rejects.toThrow()
    } finally {
      client.close(); await closeCoreServer(server); await runtime.shutdown(); rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
}

describe('会话文件路由边界', () => {
  const cases: Array<{ channel: keyof typeof AGENT_IPC_CHANNELS; args: unknown[] }> = [
    { channel: 'GET_SESSION_PATH', args: ['workspace', 'sid'] },
    { channel: 'GET_SESSION_STORAGE_PATH', args: ['workspace', 'sid'] },
    { channel: 'CORE_SESSION_FILE_ROOTS', args: ['sid'] },
    { channel: 'CORE_SESSION_LIST_DIRECTORY', args: [{ sessionId: 'sid', path: '/fixture' }] },
    { channel: 'CORE_SESSION_FS_OP', args: [{ sessionId: 'sid', op: 'rename', path: '/fixture/a', name: 'b' }] },
    { channel: 'SAVE_FILES_TO_SESSION', args: [{ sessionId: 'sid', files: [{ filename: 'a.txt', data: 'YQ==' }] }] },
  ]
  test('Core 断连不回落桌面，跨 Core 会话不允许本机读取', async () => {
    for (const entry of cases) await expect(registeredHandler(entry.channel, routes(null).deps)(...entry.args)).rejects.toThrow('Core 未连接')
    const { deps } = routes(null)
    await expect(registeredHandler('CORE_SESSION_FILE_ROOTS', deps)('core:other:sid')).rejects.toThrow('会话不属于当前本机 Core')
  })
  test('所有文件入口都拒绝切 Core 后迟到的结果；多附件上传停止向旧 Core 追加写入', async () => {
    for (const entry of cases) {
      const result = { workbench: '/fixture', workspaceRoot: '/project', project: false, filename: 'a.txt', path: '/fixture/a.txt' }
      let route: ReturnType<typeof routes>
      const respond = async () => { route.switchGeneration(); return result }
      const client = { getSessionFileRoots: respond, listSessionDirectory: respond, sessionFileOp: respond, saveAttachment: respond }
      // 这里仅模拟已查阅的四个传输方法；真实 Client 已在上面的 HTTP 用例覆盖。
      route = routes(client as unknown as CoreClient)
      await expect(registeredHandler(entry.channel, route.deps)(...entry.args)).rejects.toThrow('Core 已切换')
    }
    let count = 0
    const route = routes({ saveAttachment: async () => { count++; route.switchGeneration(); return { filename: 'a.txt', path: '/fixture/a.txt' } } } as unknown as CoreClient)
    await expect(registeredHandler('SAVE_FILES_TO_SESSION', route.deps)({ sessionId: 'sid', files: [
      { filename: 'a.txt', data: 'YQ==' }, { filename: 'b.txt', data: 'Yg==' },
    ] })).rejects.toThrow('Core 已切换')
    expect(count).toBe(1)
  })
  test('显式 legacy 模式保留原路径和上传行为', async () => {
    const deps = { captureCoreNativeRoute: () => null, assertSensitiveAgentIpcSender: () => {}, assertLocalWorkspaceFiles: () => {},
      resolveAgentSessionUiRootPath: () => '/legacy/project', resolveAgentSessionStoragePath: () => '/legacy/session', saveFilesToAgentSession: () => ['legacy'] }
    expect(await registeredHandler('GET_SESSION_PATH', deps)('w', 's')).toBe('/legacy/project')
    expect(await registeredHandler('GET_SESSION_STORAGE_PATH', deps)('w', 's')).toBe('/legacy/session')
    expect(await registeredHandler('SAVE_FILES_TO_SESSION', deps)({ sessionId: 's', files: [] })).toEqual(['legacy'])
  })
})

describe('用户打开/定位 Core 工作台', () => {
  test('Given 工作台点击 When Core 断连/切换/目录身份不符 Then 不调用系统 shell；legacy仍兼容', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-shell-')))
    try {
      const workbench = join(root, 'session-workspaces', 'sid')
      mkdirSync(workbench, { recursive: true }); writeFileSync(join(workbench, 'a.txt'), 'a')
      const disconnected = shellAccess(root, routes(null).deps.captureCoreNativeRoute)
      await expect(disconnected.open(workbench)).rejects.toThrow('Core 未连接')
      expect(disconnected.opened).toEqual([])
      let route: ReturnType<typeof routes>
      route = routes({ getSessionFileRoots: async () => { route.switchGeneration(); return { workbench } } } as unknown as CoreClient)
      const stale = shellAccess(root, route.deps.captureCoreNativeRoute)
      await expect(stale.reveal(workbench)).rejects.toThrow('Core 已切换')
      expect(stale.revealed).toEqual([])
      const mismatch = shellAccess(root, () => ({ sessionId: 'sid', assertCurrent: () => {}, client: { getSessionFileRoots: async () => ({ workbench: root }) } }))
      await expect(mismatch.open(workbench)).rejects.toThrow('路径不属于当前 Core')
      const remote = shellAccess(root, () => { throw new Error('不能查询') }, false)
      await expect(remote.open(workbench)).rejects.toThrow('远程路径禁止')
      expect(remote.opened).toEqual([])
      const legacyRoot = join(root, 'agent-workspaces', 'ws', 'sid')
      mkdirSync(legacyRoot, { recursive: true })
      const legacy = shellAccess(root, () => null)
      await legacy.open(legacyRoot)
      expect(legacy.opened).toEqual([legacyRoot])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('Given 工作台路径 When 顶层/不存在会话/链接逃逸/相对路径 Then 拒绝；系统应用错误向UI返回', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-shell-boundary-')))
    try {
      const workbench = join(root, 'session-workspaces', 'sid')
      mkdirSync(workbench, { recursive: true }); writeFileSync(join(workbench, 'a.txt'), 'a')
      writeFileSync(join(root, 'credential.json'), 'private')
      symlinkSync(join(root, 'credential.json'), join(workbench, 'escape'))
      const shell = shellAccess(root, (id: string) => ({ sessionId: id, assertCurrent: () => {}, client: {
        getSessionFileRoots: async () => { if (id !== 'sid') throw new Error('会话不存在'); return { workbench } },
      } }))
      mkdirSync(join(root, 'session-workspaces', 'deleted'))
      for (const path of [join(root, 'session-workspaces'), join(root, 'session-workspaces', 'deleted'), join(workbench, 'escape'), 'a.txt']) {
        await expect(shell.open(path)).rejects.toThrow()
      }
      expect(shell.opened).toEqual([])
      const failed = shellAccess(root, () => ({ sessionId: 'sid', assertCurrent: () => {}, client: { getSessionFileRoots: async () => ({ workbench }) } }), true, '没有关联应用')
      await expect(failed.open(join(workbench, 'a.txt'))).rejects.toThrow('打开文件失败: 没有关联应用')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
