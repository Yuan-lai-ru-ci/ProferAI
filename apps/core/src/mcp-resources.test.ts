import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEffectiveAgentPresetPolicy } from '@profer/shared'
import { loadCoreMcpServers } from './mcp-resources'
import { PiMcpClientManager, discoverExternalMcpTools } from '@profer/agent-provider-pi/pi/mcp-tools'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import { createCoreAgentRuntime } from './runtime'

const policy = (names?: string[]) => createEffectiveAgentPresetPolicy({ id: 'fixture', name: 'fixture', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, ...(names ? { mcpServerNames: names } : {}) }, { presetId: 'fixture', presetScope: 'builtin-meta' })

test('Core MCP白名单、项目覆盖与控制服务器保留边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-mcp-config-'))
  try {
    const base = { servers: { demo: { command: 'unused-fixture', env: { KEEP: 'a', CHANGE: 'base' }, enabled: true }, disabled: { type: 'http', url: 'http://127.0.0.1:1', enabled: false } } }
    await writeFile(join(root, 'mcp.json'), JSON.stringify(base))
    await writeFile(join(root, 'mcp.local.json'), JSON.stringify({ servers: { demo: { env: { CHANGE: 'local' } } } }))
    expect(loadCoreMcpServers(root, true, policy(['demo']))).toMatchObject({ demo: { type: 'stdio', command: 'unused-fixture', env: { KEEP: 'a', CHANGE: 'local' } } })
    expect(loadCoreMcpServers(root, false, policy(['demo'])).demo?.env).toEqual({ KEEP: 'a', CHANGE: 'base' })
    expect(loadCoreMcpServers(root, false, policy())).not.toHaveProperty('disabled')
    await expect(readFile(join(root, 'mcp.json'), 'utf8')).resolves.toBe(JSON.stringify(base))
    expect(() => loadCoreMcpServers(root, false, policy(['disabled']))).toThrow('不存在、禁用或不可用')
    expect(() => loadCoreMcpServers(root, false, policy(['missing']))).toThrow('不存在、禁用或不可用')
    await writeFile(join(root, 'mcp.json'), '{broken')
    expect(loadCoreMcpServers(root, true, policy([]))).toEqual({})
    expect(() => loadCoreMcpServers(root, false, policy())).toThrow()
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ servers: { goal: { type: 'http', url: 'http://127.0.0.1:1' } } }))
    expect(() => loadCoreMcpServers(root, false, policy())).toThrow('不能覆盖')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('MCP严格连接失败不跳过、不启动provider；禁用项不建立连接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-mcp-failure-'))
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end('isolated fixture failure') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ textChunks: ['must not execute'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  const manager = new PiMcpClientManager()
  try {
    const workspace = runtime.workspaces.createManaged('failure fixture')
    const configDir = join(root, 'workspaces', workspace.slug)
    const endpoint = { type: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, enabled: false }
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ servers: { fixture: endpoint } }))
    expect(loadCoreMcpServers(configDir, false, policy())).toEqual({})
    expect(requests).toBe(0)
    await expect(discoverExternalMcpTools({ fixture: endpoint }, { manager, strict: true })).rejects.toThrow('连接或列出工具失败')
    expect(requests).toBeGreaterThan(0)
    expect(manager.snapshots()).toEqual([])
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ servers: { fixture: { ...endpoint, enabled: true } } }))
    const session = runtime.sessions.create({ title: 'failed MCP fixture', runtime: 'pi', workspaceId: workspace.id, channelId: 'offline', modelId: 'claude-sonnet-4-5' })
    const outcome = await runtime.coordinator.run(runtime.createQuery(session, 'do not run if MCP cannot load')).promise
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringContaining('连接或列出工具失败') })
    expect(transport.calls).toHaveLength(0)
    await expect(discoverExternalMcpTools({ fixture: { type: 'unknown' } }, { manager, strict: true })).rejects.toThrow('transport类型')
  } finally {
    await manager.dispose(); await runtime.shutdown()
    prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
