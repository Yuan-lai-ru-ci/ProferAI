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
  disconnectMcpServer,
  discoverExternalMcpTools,
  listMcpConnectionSnapshots,
  reconcileMcpServers,
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
