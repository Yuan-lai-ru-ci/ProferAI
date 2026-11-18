import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { PiMcpClientManager, discoverExternalMcpTools } from '@profer/agent-provider-pi/pi/mcp-tools'
import { createCoreAgentRuntime } from './runtime'

// 本轮无害MCP fixture：仅loopback临时端口，响应固定文本，不访问文件/网络。
test.each(['success', 'uncertain-call'] as const)('Core Pi所属MCP实际握手/调用与不确定结果不重放：%s', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-mcp-'))
  const methods: string[] = []
  const calls: unknown[] = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    methods.push(body.method)
    if (!('id' in body)) { res.writeHead(202).end(); return }
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'isolated-core-fixture', version: '1' } }
    else if (body.method === 'tools/list') result = { tools: [{ name: 'fixture_echo', description: 'Return harmless fixed fixture text', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }
    else if (body.method === 'tools/call') {
      calls.push(body.params)
      if (scenario === 'uncertain-call') { res.destroy(); return }
      result = { content: [{ type: 'text', text: 'CORE_MCP_FIXTURE_RESULT' }] }
    }
    else result = {}
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ toolCall: { id: 'mcp-echo', name: 'mcp__fixture__fixture_echo', arguments: { value: 'isolated' } } }, { textChunks: ['DONE'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    const workspace = runtime.workspaces.createManaged('MCP fixture')
    const configDir = join(root, 'workspaces', workspace.slug)
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ servers: { fixture: { type: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` } } }))
    await writeFile(join(configDir, 'agent-presets.json'), JSON.stringify({ presets: [{ id: 'mcp-fixture', name: 'MCP fixture', version: '1', createdAt: 0, updatedAt: 0, mcpServerNames: ['fixture'], skillSlugs: [] }] }))
    const session = runtime.sessions.create({ title: 'MCP fixture', runtime: 'pi', permissionMode: 'bypassPermissions', channelId: 'offline', modelId: 'claude-sonnet-4-5', workspaceId: workspace.id,
      presetReference: { presetId: 'mcp-fixture', presetScope: 'workspace', workspaceSlug: workspace.slug } })
    expect(await runtime.coordinator.run(runtime.createQuery(session, 'Run the isolated MCP fixture')).promise).toEqual({ status: 'completed' })
    expect(methods).toContain('initialize')
    expect(methods).toContain('tools/list')
    expect(calls).toEqual([{ name: 'fixture_echo', arguments: { value: 'isolated' } }])
    if (scenario === 'success') expect(JSON.stringify(runtime.sessions.readMessages(session.id))).toContain('CORE_MCP_FIXTURE_RESULT')
    else expect(JSON.stringify(runtime.sessions.readMessages(session.id))).not.toContain('CORE_MCP_FIXTURE_RESULT')
    expect(transport.calls).toHaveLength(2)
    if (scenario === 'success') {
      const first = new PiMcpClientManager(), second = new PiMcpClientManager()
      const endpoint = { fixture: { type: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` } }
      const before = methods.filter(method => method === 'initialize').length
      try {
        await discoverExternalMcpTools(endpoint, { manager: first, strict: true, workspaceSlug: 'same-scope' })
        await discoverExternalMcpTools(endpoint, { manager: second, strict: true, workspaceSlug: 'same-scope' })
        expect(methods.filter(method => method === 'initialize')).toHaveLength(before + 2)
        await first.dispose()
        expect(second.snapshots()).toHaveLength(1)
        expect(await second.callTool('fixture', endpoint.fixture, 'fixture_echo', { value: 'second-manager' }, undefined, { strict: true, workspaceSlug: 'same-scope' })).toMatchObject({ content: [{ text: 'CORE_MCP_FIXTURE_RESULT' }] })
      } finally { await first.dispose(); await second.dispose() }
    }
  } finally {
    await runtime.shutdown()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(root, { recursive: true, force: true })
  }
}, 12000)
