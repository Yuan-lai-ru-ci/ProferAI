import { afterEach, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { __resetMcpBridgeForTest, __setMcpConnectionFactoryForTest, discoverExternalMcpTools, disconnectMcpServer, listMcpConnectionSnapshots, reconcileMcpServers } from './mcp-tools'

afterEach(__resetMcpBridgeForTest)

test('Given 两个工作区使用同名 MCP When 单工作区禁用及断开 Then 不影响另一工作区', async () => {
  __setMcpConnectionFactoryForTest(async () => ({
    client: { listTools: async () => ({ tools: [] }) } as unknown as Client,
    transport: { close: async () => {} } as unknown as Transport,
  }))
  const servers = { demo: { type: 'stdio', command: 'offline-fixture' } }
  await discoverExternalMcpTools(servers, { workspaceSlug: 'a' })
  await discoverExternalMcpTools(servers, { workspaceSlug: 'b' })
  await reconcileMcpServers([], 'a')
  expect(listMcpConnectionSnapshots().map(s => s.workspaceSlug)).toEqual(['b'])
  await discoverExternalMcpTools(servers, { workspaceSlug: 'a' })
  await disconnectMcpServer('demo', 'a')
  expect(listMcpConnectionSnapshots().map(s => s.workspaceSlug)).toEqual(['b'])
})
