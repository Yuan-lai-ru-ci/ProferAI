import { afterAll, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentWorkspace, McpConnectionSnapshot, McpServerEntry } from '@profer/shared'
import { PiMcpClientManager, discoverExternalMcpTools } from '@profer/agent-provider-pi/pi/mcp-tools'
import { mcpConfigFingerprint } from '@profer/agent-provider-pi/pi/mcp-probe'
import { executeCoreMcpOperation, reconcileCoreMcpConnections } from './resource-mcp'
import type { CoreResourceOperationContext } from './resource-paths'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
function fixture(project = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-mcp-management-')))
  roots.push(root)
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') }
  const workspace: AgentWorkspace = { id: 'owned-id', slug: 'same', name: 'Same', createdAt: 0, updatedAt: 0,
    ...(project ? { storageMode: 'project', rootPath: join(root, 'project') } : {}) }
  const directory = project ? join(root, 'project', '.profer') : join(config.workspaceRoot, workspace.slug)
  mkdirSync(directory, { recursive: true })
  const manager = new PiMcpClientManager()
  const context: CoreResourceOperationContext = { config, workspaces: { list: () => [workspace] }, mcpManager: manager }
  const call = (operation: string, ...args: unknown[]) => executeCoreMcpOperation(context, operation, args)
  return { root, workspace, directory, manager, context, call, scope: `${root}:${workspace.id}` }
}
async function endpoint() {
  let initializations = 0
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text) as { id?: number; method: string }
    if (body.id === undefined) { res.writeHead(202).end(); return }
    let result: unknown = {}
    if (body.method === 'initialize') {
      initializations++
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'isolated-management-fixture', version: '1' } }
    } else if (body.method === 'tools/list') result = { tools: [{ name: 'fixture_read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const entry: McpServerEntry = { type: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, enabled: true }
  return { entry, initializations: () => initializations,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

test('独立探测真实握手/工具清单；项目结果仅落本机层，保留未知字段且不复制凭据', async () => {
  const f = fixture(true), e = await endpoint()
  const base = JSON.stringify({ futureBase: true, servers: { demo: { ...e.entry, headers: { 'X-fixture': 'synthetic-base-value' } } } })
  writeFileSync(join(f.directory, 'mcp.json'), base)
  writeFileSync(join(f.directory, 'mcp.local.json'), JSON.stringify({ futureLocal: true, servers: { demo: { env: { FIXTURE_ONLY: 'synthetic-local-value' } } } }))
  try {
    expect(await f.call('probeMcpServer', 'demo', e.entry, 'same')).toMatchObject({ success: true, tools: [{ name: 'fixture_read', readOnly: true }] })
    expect(e.initializations()).toBe(1)
    expect(f.manager.snapshots()).toEqual([])
    expect(readFileSync(join(f.directory, 'mcp.json'), 'utf8')).toBe(base)
    const local = JSON.parse(readFileSync(join(f.directory, 'mcp.local.json'), 'utf8'))
    expect(local).toMatchObject({ futureLocal: true, servers: { demo: { env: { FIXTURE_ONLY: 'synthetic-local-value' }, lastTestResult: { success: true, fingerprint: mcpConfigFingerprint(e.entry), timestamp: expect.any(Number) } } } })
    expect(local.servers.demo.headers).toBeUndefined()
    expect(local.servers.demo.url).toBeUndefined()
    await f.call('probeMcpServer', 'unsaved', e.entry, 'same')
    expect(JSON.parse(readFileSync(join(f.directory, 'mcp.local.json'), 'utf8')).servers.unsaved).toBeUndefined()
  } finally { await f.manager.dispose(); await e.close() }
})

test('同slug独立Core及同名其他工作区连接隔离；快照slug投影、重连、禁用立即释放', async () => {
  const a = fixture(), b = fixture(), e = await endpoint()
  const servers = { demo: { ...e.entry } }
  try {
    await discoverExternalMcpTools(servers, { manager: a.manager, workspaceSlug: a.scope, strict: true })
    await discoverExternalMcpTools(servers, { manager: a.manager, workspaceSlug: `${a.root}:other`, strict: true })
    await discoverExternalMcpTools(servers, { manager: b.manager, workspaceSlug: b.scope, strict: true })
    const before = await a.call('listMcpConnectionSnapshots') as McpConnectionSnapshot[]
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ serverName: 'demo', workspaceSlug: 'same', toolCount: 1 })
    expect(JSON.stringify(before)).not.toContain(a.root)
    expect(await a.call('restartMcpServer', 'demo', 'same')).toEqual({ ok: true, message: '已重启 1 个连接（仅工作区 same）' })
    expect(a.manager.snapshots().map(item => item.workspaceSlug)).toEqual([`${a.root}:other`])
    expect(await a.call('listMcpConnectionSnapshots')).toEqual([])
    expect(await b.call('listMcpConnectionSnapshots')).toHaveLength(1)
    await discoverExternalMcpTools(servers, { manager: a.manager, workspaceSlug: a.scope, strict: true })
    const [after] = await a.call('listMcpConnectionSnapshots') as McpConnectionSnapshot[]
    expect(after!.epoch).toBeGreaterThan(before[0]!.epoch)
    expect(e.initializations()).toBe(4)
    await reconcileCoreMcpConnections(a.context, a.workspace.id, [])
    expect(await a.call('listMcpConnectionSnapshots')).toEqual([])
    expect(await b.call('listMcpConnectionSnapshots')).toHaveLength(1)
    expect(await a.call('restartMcpServer', 'not-connected', 'same')).toMatchObject({ ok: true })
    await discoverExternalMcpTools(servers, { manager: a.manager, workspaceSlug: a.scope, strict: true })
    expect(await a.call('restartMcpServer', 'demo')).toEqual({ ok: true, message: '已重启 2 个连接' })
    expect(a.manager.snapshots()).toEqual([])
    expect(await b.call('listMcpConnectionSnapshots')).toHaveLength(1)
  } finally { await a.manager.dispose(); await b.manager.dispose(); await e.close() }
})

test('无工作区不落盘；失败结果可区分且不暴露错误原文；managed结果持久化', async () => {
  const f = fixture()
  const entry: McpServerEntry = { type: 'stdio', enabled: true }
  writeFileSync(join(f.directory, 'mcp.json'), JSON.stringify({ future: true, servers: { demo: entry } }))
  try {
    expect(await f.call('probeMcpServer', 'draft', entry)).toMatchObject({ success: false, reason: 'command-missing' })
    expect(existsSync(join(f.root, 'mcp.json'))).toBe(false)
    expect(await f.call('probeMcpServer', 'demo', entry, 'same')).toMatchObject({ success: false, reason: 'command-missing' })
    expect(JSON.parse(readFileSync(join(f.directory, 'mcp.json'), 'utf8'))).toMatchObject({ future: true, servers: { demo: { lastTestResult: { success: false, reason: 'command-missing' } } } })
    expect(await f.call('probeMcpServer', 'draft', { type: 'http', url: 'invalid-synthetic-value', enabled: true })).toEqual({ success: false, message: '服务地址格式不合法', reason: 'unknown' })
  } finally { await f.manager.dispose() }
})

test('无manager拒绝fallback；工作区/控制server/恶意参数/配置软链在连接前拒绝', async () => {
  const f = fixture(), e = await endpoint()
  try {
    await expect(executeCoreMcpOperation({ ...f.context, mcpManager: undefined }, 'listMcpConnectionSnapshots', [])).rejects.toThrow('不会回退')
    await expect(f.call('restartMcpServer', 'demo', 'missing')).rejects.toThrow('不存在')
    await expect(f.call('restartMcpServer', 'demo', '../escape')).rejects.toThrow()
    await expect(f.call('probeMcpServer', 'goal', e.entry)).rejects.toThrow('内置')
    await expect(f.call('probeMcpServer', 'demo', { ...e.entry, headers: { Authorization: 123 } })).rejects.toThrow()
    await expect(f.call('probeMcpServer', 'demo', { ...e.entry, args: [12] })).rejects.toThrow()
    symlinkSync(join(f.root, 'outside.json'), join(f.directory, 'mcp.json'))
    await expect(f.call('probeMcpServer', 'demo', e.entry, 'same')).rejects.toThrow('软链')
    expect(e.initializations()).toBe(0)
    expect(existsSync(join(f.root, 'outside.json'))).toBe(false)
  } finally { await f.manager.dispose(); await e.close() }
})

test('真实Core HTTP注册链：鉴权、探测持久化、快照、可选工作区重连与参数拒绝', async () => {
  const { createCoreAgentRuntime } = await import('./runtime')
  const { createCoreServer, listenCoreServer, closeCoreServer } = await import('./server')
  const f = fixture(), e = await endpoint()
  const runtime = createCoreAgentRuntime({ ...f.context.config, mockAgent: true })
  const workspace = runtime.workspaces.createManaged('Http fixture')
  const server = createCoreServer({ runtime, version: 'fixture', apiKey: 'synthetic-fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resources/operations`
  async function call(operation: string, args: unknown[] = [], auth = true) {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer synthetic-fixture-only' } : {}) }, body: JSON.stringify({ operation, args }) })
    return { status: response.status, body: await response.json() as { result?: unknown; error?: string } }
  }
  try {
    expect((await call('listMcpConnectionSnapshots', [], false)).status).toBe(401)
    expect((await call('saveWorkspaceMcpConfig', [workspace.slug, { servers: { demo: e.entry } }])).status).toBe(200)
    expect((await call('probeMcpServer', ['demo', e.entry, workspace.slug])).body.result).toMatchObject({ success: true, tools: [{ name: 'fixture_read' }] })
    expect((await call('getWorkspaceMcpConfig', [workspace.slug])).body.result).toMatchObject({ servers: { demo: { lastTestResult: { success: true, fingerprint: mcpConfigFingerprint(e.entry) } } } })
    expect((await call('listMcpConnectionSnapshots')).body.result).toEqual([])
    expect((await call('restartMcpServer', ['demo', workspace.slug])).body.result).toEqual({ ok: true, message: `已重启 0 个连接（仅工作区 ${workspace.slug}）` })
    expect((await call('restartMcpServer', ['demo'])).body.result).toEqual({ ok: true, message: '已重启 0 个连接' })
    expect((await call('restartMcpServer', ['demo', 'missing'])).status).toBe(400)
    expect((await call('probeMcpServer', ['demo'])).status).toBe(400)
    expect((await call('listMcpConnectionSnapshots', ['extra'])).status).toBe(400)
  } finally { await closeCoreServer(server); await runtime.shutdown(); await f.manager.dispose(); await e.close() }
})
