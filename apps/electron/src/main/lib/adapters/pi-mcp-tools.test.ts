/**
 * Pi MCP 连接生命周期测试
 *
 * 用注入的连接工厂替换真实子进程，只验证桥接层的 key/epoch/快照/回收语义。
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __reapIdleConnectionsForTest,
  __resetMcpBridgeForTest,
  __setMcpConnectionFactoryForTest,
  buildPiMcpTools,
  disconnectMcpServer,
  discoverExternalMcpTools,
  listMcpConnectionSnapshots,
  reconcileMcpServers,
  refreshStaleMcpConnections,
  restartMcpServer,
} from './pi-mcp-tools'

class FakeTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: unknown) => void
  closed = false

  constructor(readonly pid: number | null) {}

  async start(): Promise<void> {}

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
    this.onclose?.()
  }
}

interface FakeConnection {
  serverName: string
  transport: FakeTransport
  client: Client
  toolNames: string[]
  pings: number
}

let created: FakeConnection[] = []
let nextPid = 5000

function installFakeConnections(): void {
  __setMcpConnectionFactoryForTest(async (serverName) => {
    const toolNames = [`${serverName}_tool`]
    const transport = new FakeTransport(nextPid++)
    const handle: FakeConnection = {
      serverName,
      transport,
      client: undefined as unknown as Client,
      toolNames,
      pings: 0,
    }
    handle.client = {
      listTools: async () => ({
        tools: toolNames.map(name => ({
          name,
          description: `${name} 描述`,
          inputSchema: { type: 'object', properties: {} },
        })),
      }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ping: async () => {
        handle.pings += 1
        return {}
      },
    } as unknown as Client
    created.push(handle)
    return { client: handle.client, transport: transport as unknown as Transport }
  })
}

beforeEach(() => {
  created = []
  nextPid = 5000
  installFakeConnections()
})

afterEach(async () => {
  await __resetMcpBridgeForTest()
  setSystemTime()
})

describe('Pi MCP 连接生命周期', () => {
  test('restart 关闭同 server 的所有 key，新连接 epoch 更大且仍可 listTools', async () => {
    const servers = { demo: { type: 'stdio', command: 'demo-server' } }
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-a' })
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-b' })

    const oldSnapshots = listMcpConnectionSnapshots()
    expect(oldSnapshots).toHaveLength(2)

    const result = await restartMcpServer('demo')
    expect(result).toEqual({ ok: true, message: '已重启 2 个连接' })
    expect(created.map(item => item.transport.closed)).toEqual([true, true])
    expect(listMcpConnectionSnapshots()).toHaveLength(0)

    // 重启后仍可正常 listTools：disposed 语义未被污染
    const tools = await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-a' })
    expect(tools.map(item => item.tool.name)).toEqual(['demo_tool'])

    const [snapshot] = listMcpConnectionSnapshots()
    const maxOldEpoch = Math.max(...oldSnapshots.map(item => item.epoch))
    expect(snapshot!.epoch).toBeGreaterThan(maxOldEpoch)
  })

  test('没有连接时 restart 仍返回 ok', async () => {
    expect(await restartMcpServer('not-connected')).toEqual({ ok: true, message: '已重启 0 个连接' })
  })

  test('带 workspaceSlug 的 restart 只关该工作区连接，不影响其它工作区', async () => {
    const servers = { demo: { type: 'stdio', command: 'demo-server' } }
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-a' })
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-b' })

    const result = await restartMcpServer('demo', { workspaceSlug: 'ws-a' })
    expect(result).toEqual({ ok: true, message: '已重启 1 个连接（仅工作区 ws-a）' })

    // ws-a 的旧连接已关闭，ws-b 仍在
    const remaining = listMcpConnectionSnapshots()
    expect(remaining.map(item => item.workspaceSlug)).toEqual(['ws-b'])
    expect(created.filter(item => item.transport.closed)).toHaveLength(1)
  })

  test('显式传空对象等同于全量 restart，保持设置页原有语义', async () => {
    const servers = { demo: { type: 'stdio', command: 'demo-server' } }
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-a' })
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws-b' })

    const result = await restartMcpServer('demo', {})
    expect(result).toEqual({ ok: true, message: '已重启 2 个连接' })
    expect(listMcpConnectionSnapshots()).toHaveLength(0)
  })

  test('reconcile 关闭未列出的 server，保留列出的', async () => {
    const servers = {
      keep: { type: 'stdio', command: 'keep-server' },
      drop: { type: 'stdio', command: 'drop-server' },
    }
    await discoverExternalMcpTools(servers, { workspaceSlug: 'ws' })
    expect(listMcpConnectionSnapshots()).toHaveLength(2)

    await reconcileMcpServers(['keep'])

    expect(listMcpConnectionSnapshots().map(item => item.serverName)).toEqual(['keep'])
    expect(created.find(item => item.serverName === 'drop')!.transport.closed).toBe(true)
    expect(created.find(item => item.serverName === 'keep')!.transport.closed).toBe(false)
  })

  test('快照字段：pid/toolCount/epoch/connectedAt 与外部文件过期标记', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-state-'))
    const statePath = join(dir, 'server.toml')
    writeFileSync(statePath, 'x = 1\n')
    // 先回拨 mtime，避免“刚写入的文件”被当成连接后修改
    const past = new Date(Date.now() - 60_000)
    utimesSync(statePath, past, past)

    const connectedAtFloor = Date.now()
    await discoverExternalMcpTools(
      { demo: { type: 'stdio', command: 'demo-server' } },
      { workspaceSlug: 'ws', externalStatePaths: { demo: [statePath] } },
    )

    const [snapshot] = listMcpConnectionSnapshots()
    expect(snapshot!.serverName).toBe('demo')
    expect(snapshot!.workspaceSlug).toBe('ws')
    expect(snapshot!.pid).toBe(created[0]!.transport.pid)
    expect(snapshot!.toolCount).toBe(1)
    expect(snapshot!.epoch).toBeGreaterThan(0)
    expect(snapshot!.connectedAt).toBeGreaterThanOrEqual(connectedAtFloor)
    expect(snapshot!.lastUsedAt).toBeGreaterThanOrEqual(snapshot!.connectedAt)
    expect(snapshot!.externalStateStale).toBe(false)

    // 外部配置文件在连接建立后被修改 → 标记过期
    const future = new Date(snapshot!.connectedAt + 60_000)
    utimesSync(statePath, future, future)
    expect(listMcpConnectionSnapshots()[0]!.externalStateStale).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  test('外部配置变更后 refreshStaleMcpConnections 只关闭受影响的连接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-refresh-'))
    const statePath = join(dir, 'server.toml')
    writeFileSync(statePath, 'x = 1\n')
    const past = new Date(Date.now() - 60_000)
    utimesSync(statePath, past, past)

    await discoverExternalMcpTools(
      { demo: { type: 'stdio', command: 'demo-server' }, other: { type: 'stdio', command: 'other-server' } },
      { workspaceSlug: 'ws', externalStatePaths: { demo: [statePath] } },
    )
    expect(listMcpConnectionSnapshots()).toHaveLength(2)

    // 文件没动：一条都不关
    expect(await refreshStaleMcpConnections({ demo: [statePath] })).toEqual([])
    expect(listMcpConnectionSnapshots()).toHaveLength(2)

    // 文件在连接建立后被改写：只关 demo，其它 server 不受牵连
    const future = new Date(Date.now() + 60_000)
    utimesSync(statePath, future, future)
    expect(await refreshStaleMcpConnections({ demo: [statePath] })).toEqual(['demo'])
    expect(listMcpConnectionSnapshots().map(item => item.serverName)).toEqual(['other'])
    expect(created.find(item => item.serverName === 'demo')!.transport.closed).toBe(true)
    expect(created.find(item => item.serverName === 'other')!.transport.closed).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })

  test('buildPiMcpTools 每轮准备时自动淘汰外部配置已变更的连接并重建', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-rebuild-'))
    const statePath = join(dir, 'server.toml')
    writeFileSync(statePath, 'x = 1\n')
    // 用可控时钟：mtime 必须落在「旧连接建立后、下次准备前」，才不会连新连接也判过期
    const base = Date.now()
    setSystemTime(base)
    const past = new Date(base - 60_000)
    utimesSync(statePath, past, past)

    const servers = { demo: { type: 'stdio', command: 'demo-server' } }
    const options = { workspaceSlug: 'ws', externalStatePaths: { demo: [statePath] } }

    await buildPiMcpTools(servers, undefined, options)
    expect(created).toHaveLength(1)
    const first = created[0]!

    // 配置没变：复用同一条连接，不重建
    await buildPiMcpTools(servers, undefined, options)
    expect(created).toHaveLength(1)
    expect(first.transport.closed).toBe(false)

    // 配置文件在连接建立后变更 → 下次准备淘汰旧连接并重建，新连接不再 stale
    const changedAt = new Date(base + 1_000)
    utimesSync(statePath, changedAt, changedAt)
    setSystemTime(base + 5_000)
    await buildPiMcpTools(servers, undefined, options)

    expect(first.transport.closed).toBe(true)
    expect(created).toHaveLength(2)
    expect(listMcpConnectionSnapshots()[0]!.externalStateStale).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })

  test('reaper 关闭空闲连接，保留刚用过的连接', async () => {
    const base = Date.now()
    setSystemTime(base)
    await discoverExternalMcpTools({ old: { type: 'stdio', command: 'old-server' } })

    setSystemTime(base + 5 * 60_000)
    await discoverExternalMcpTools({ fresh: { type: 'stdio', command: 'fresh-server' } })

    await __reapIdleConnectionsForTest(60_000)

    expect(listMcpConnectionSnapshots().map(item => item.serverName)).toEqual(['fresh'])
    expect(created.find(item => item.serverName === 'old')!.transport.closed).toBe(true)
    expect(created.find(item => item.serverName === 'fresh')!.transport.closed).toBe(false)
  })

  test('disconnect 关闭连接但不清 disposed，之后可重连', async () => {
    const servers = { demo: { type: 'stdio', command: 'demo-server' } }
    await discoverExternalMcpTools(servers)

    await disconnectMcpServer('demo')
    expect(listMcpConnectionSnapshots()).toHaveLength(0)
    expect(created[0]!.transport.closed).toBe(true)

    const tools = await discoverExternalMcpTools(servers)
    expect(tools.map(item => item.tool.name)).toEqual(['demo_tool'])
    expect(created).toHaveLength(2)
  })
})
