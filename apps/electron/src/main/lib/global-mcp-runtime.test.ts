// 本文件验收旧桌面 writer；新核默认与归属保护由 Core 专项测试覆盖。
process.env.PROFER_LOCAL_CORE_MODE = 'legacy'

import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'profer-global-mcp-runtime-'))
const previous = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = root
// 与桌面启动顺序一致：先装配宿主，再从资源端口按需加载内置 MCP。
await import('./agent-service')
const manager = await import('./agent-workspace-manager')
const { saveGlobalMcpServer } = await import('./global-mcp-store')
const { createElectronResourcePort, finalizeRuntimeResourcePreparation } = await import('./agent-runtime-host')
const { agentRuntimePolicyRuns } = await import('./agent-runtime-policy-snapshot')
const { buildRuntimeTurnUserPrompt } = await import('./agent-runtime-turn-prompt')
const { createAgentSession } = await import('./agent-session-manager')
const { __setMcpConnectionFactoryForTest, disconnectMcpServer } = await import('./adapters/pi-mcp-tools')
const { getWorkspaceMcpPath } = await import('./config-paths')
const bound = manager.createAgentWorkspace('global-fixture-bound')
const unbound = manager.createAgentWorkspace('global-fixture-unbound')
const name = 'shared-demo'
const marker = 'credential-fixture-not-for-prompt'
const entry = { type: 'http' as const, url: 'https://example.invalid/test', headers: { Authorization: marker }, enabled: true }
saveGlobalMcpServer({ name, entry, workspaceIds: [bound.id] }, 'create')
const port = createElectronResourcePort()
__setMcpConnectionFactoryForTest(async () => ({ client: { listTools: async () => ({ tools: [{ name: 'inspect', inputSchema: { type: 'object' } }] }), close: async () => {} }, transport: { close: async () => {} } }) as never)
afterAll(async () => {
  await disconnectMcpServer(name)
  __setMcpConnectionFactoryForTest()
  agentRuntimePolicyRuns.clear()
  if (previous === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

test('仅运行读取合并视图，编辑和导出使用的工作区配置不含共享凭据', () => {
  expect(port.getMcpConfig!({ sessionId: 'fixture', workspaceSlug: bound.slug }).servers[name]).toEqual(entry)
  expect(port.getMcpConfig!({ sessionId: 'fixture', workspaceSlug: unbound.slug }).servers[name]).toBeUndefined()
  const editable = manager.getWorkspaceMcpConfig(bound.slug)
  expect(editable.servers[name]).toBeUndefined()
  manager.saveWorkspaceMcpConfig(bound.slug, editable)
  expect(readFileSync(getWorkspaceMcpPath(bound.slug), 'utf8')).not.toContain(name)
  expect(existsSync(join(root, 'global-mcp.json'))).toBe(true)
})

for (const runtime of ['claude', 'pi'] as const) for (const scenario of ['allowed', 'denied', 'unbound'] as const) {
  test(`${runtime} / ${scenario}: 全局 MCP 可见性同时受工作区引用和冻结预设约束`, async () => {
    const ws = scenario === 'unbound' ? unbound : bound
    const allowed = scenario === 'allowed'
    const session = createAgentSession('fixture', ws.id, undefined, 'model-fixture', runtime)
    agentRuntimePolicyRuns.resolveForRun(session.id, { preset: { id: 'fixture', name: 'fixture', description: '', createdAt: 0, updatedAt: 0, isBuiltin: false, mcpServerNames: scenario === 'denied' ? [] : [name] }, presetReference: { presetId: 'fixture', presetScope: 'user-global' } })
    const query = { sessionId: session.id, runtime, workspaceId: ws.id, prompt: 'fixture' }
    const resources = await port.load({ sessionId: session.id, workspaceSlug: ws.slug, workspaceId: ws.id })
    const configured = (resources.mcpResources ?? []).filter((r): r is typeof entry & { name: string } => !!r && typeof r === 'object' && 'name' in r && r.name === name)
    expect(configured.length).toBe(allowed ? 1 : 0)
    const prepared = await finalizeRuntimeResourcePreparation(query as never, { resources: { mcpResources: configured }, mcpServers: Object.fromEntries(configured.map(({ name: key, ...config }) => [key, config])) })
    if (runtime === 'claude') expect(Object.keys(prepared.mcpServers ?? {})).toEqual(allowed ? [name] : [])
    else expect((prepared.tools ?? []).map(tool => (tool as { name: string }).name)).toEqual(allowed ? ['mcp__shared_demo__inspect'] : [])
    const prompt = buildRuntimeTurnUserPrompt(query as never, { hasResume: true, mcpServerNames: configured.map(r => r.name) })
    expect(prompt.includes(name)).toBe(allowed)
    expect(prompt).not.toContain(marker)
    expect(prompt).not.toContain(entry.url)
  })
}
