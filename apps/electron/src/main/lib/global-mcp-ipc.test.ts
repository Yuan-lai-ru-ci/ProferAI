import { afterAll, expect, spyOn, test } from 'bun:test'
import { ipcMain } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_IPC_CHANNELS as C, type GlobalMcpDefinition } from '@profer/shared'

const root = mkdtempSync(join(tmpdir(), 'profer-mcp-ipc-'))
const before = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = join(root, 'config')
const { createProjectWorkspace, saveWorkspaceMcpConfig, getEffectiveWorkspaceMcpConfig } = await import('./agent-workspace-manager')
const { registerGlobalMcpIpc } = await import('./global-mcp-ipc')
const { __setMcpConnectionFactoryForTest, buildPiMcpTools, listMcpConnectionSnapshots, disconnectMcpServer } = await import('./adapters/pi-mcp-tools')
const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>()
const registration = spyOn(ipcMain, 'handle').mockImplementation((channel, listener) => { handlers.set(channel, listener) })
registerGlobalMcpIpc()
registration.mockRestore()
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`未注册 IPC: ${channel}`)
  return Promise.resolve().then(() => handler({} as Electron.IpcMainInvokeEvent, ...args))
}
const name = 'catalog'
const entry = { type: 'http' as const, url: 'https://example.invalid', enabled: true }
__setMcpConnectionFactoryForTest(async () => ({ client: { listTools: async () => ({ tools: [] }), close: async () => {} }, transport: { close: async () => {} } }) as never)
afterAll(async () => {
  await disconnectMcpServer(name)
  __setMcpConnectionFactoryForTest()
  if (before === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = before
  rmSync(root, { recursive: true, force: true })
})

test('通过设置页的四个 IPC 管理引用：仅回收使用旧定义的连接，项目 mcp.json 字节不变', async () => {
  function project(key: string) {
    const path = join(root, key)
    mkdirSync(path)
    return createProjectWorkspace({ rootPath: path, name: key, proferVersion: 'test' }).workspace
  }
  const a = project('bound-a'), b = project('local-b'), c = project('unbound-c')
  const local = { ...entry, url: 'https://local.invalid', headers: { Authorization: 'local-fixture' } }
  saveWorkspaceMcpConfig(b.slug, { servers: { [name]: local } })
  const projectFiles = [a,b,c].map(w => join(w.rootPath!, '.profer', 'mcp.json'))
  const contents = () => projectFiles.map(p => readFileSync(p,'utf8'))
  const initial = contents()
  const definition: GlobalMcpDefinition = { name, entry: { ...entry, headers: { Authorization: 'global-fixture' } }, workspaceIds: [a.id, b.id] }
  await expect(invoke(C.SAVE_GLOBAL_MCP, { ...definition, workspaceIds: [a.slug] }, 'create')).rejects.toThrow('请选择')
  await invoke(C.SAVE_GLOBAL_MCP, definition, 'create')
  expect(await invoke(C.LIST_GLOBAL_MCP)).toEqual([definition])
  expect(await invoke(C.LIST_WORKSPACE_GLOBAL_MCP, a.slug)).toEqual([{ name, enabled: true, shadowed: false }])
  expect(await invoke(C.LIST_WORKSPACE_GLOBAL_MCP, b.slug)).toEqual([{ name, enabled: true, shadowed: true }])
  expect(await invoke(C.LIST_WORKSPACE_GLOBAL_MCP, c.slug)).toEqual([])
  for (const w of [a,b]) await buildPiMcpTools({ [name]: { ...getEffectiveWorkspaceMcpConfig(w.slug).servers[name]! } }, undefined, { workspaceSlug: w.slug })
  const connected = () => listMcpConnectionSnapshots().map(s => s.workspaceSlug).sort()
  expect(connected()).toEqual([a.slug,b.slug])
  await invoke(C.SAVE_GLOBAL_MCP, { ...definition, workspaceIds: [b.id] }, 'update')
  expect(connected()).toEqual([b.slug])
  expect(getEffectiveWorkspaceMcpConfig(a.slug).servers[name]).toBeUndefined()
  await invoke(C.DELETE_GLOBAL_MCP, name)
  expect(await invoke(C.LIST_GLOBAL_MCP)).toEqual([])
  expect(connected()).toEqual([b.slug])
  expect(getEffectiveWorkspaceMcpConfig(b.slug).servers[name]).toEqual(local)
  expect(contents()).toEqual(initial)
})
