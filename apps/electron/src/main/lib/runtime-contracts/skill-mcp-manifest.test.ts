import { afterAll, expect, mock, test } from 'bun:test'
import type { AgentPreset } from '@profer/shared'
mock.module('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))
mock.module('../agent-session-manager', () => ({
  getAgentSessionMeta: () => ({ workspaceId: 'fixture' }),
  getAgentSessionSDKMessages: () => [], getAgentSessionMessages: () => [],
  appendSDKMessages() {}, enqueueSDKMessages() {}, updateAgentSessionMeta() {}, lockAgentSessionRuntime() {}, resolveAgentSessionWriteLayout() {},
}))
mock.module('../agent-workspace-manager', () => ({
  getAgentWorkspace: () => ({ slug: 'manifest-fixture' }), readWorkspaceProfile: () => ({ content: '' }),
  getWorkspaceAttachedDirectories: () => [], getWorkspaceAttachedFiles: () => [], getWorkspaceMemoryArchivePath: () => '/tmp/fixture', getWorkspaceAutoMemoryDir: () => '/tmp/fixture',
  getWorkspaceSkills: () => [], getWorkspaceMcpConfig: () => ({ servers: {} }),
}))
mock.module('../global-skill-manager', () => ({
  prepareRuntimeSkills: () => ({ path: '/fixture/source' }),
  preparePolicyRuntimeSkills: async (_source: unknown, slugs: string[]) => ({ path: `/fixture/policy/${slugs.join('-')}` }),
  getRuntimeSkillsPath: (projection: { path: string }) => `${projection.path}/skills`,
}))
// Fixture discovery supplies real routing with deterministic metadata, never user skills.
mock.module('../skill-routing', () => ({
  createSkillRoutingSnapshot: async ({ policy }: { policy: { allowedSkillSlugs?: string[] } }) => ({
    allowedSlugs: ['allowed', 'blocked'].filter(slug => policy.allowedSkillSlugs === undefined || policy.allowedSkillSlugs.includes(slug)),
    skills: ['allowed', 'blocked'].filter(slug => policy.allowedSkillSlugs === undefined || policy.allowedSkillSlugs.includes(slug)).map(slug => ({ slug })),
  }),
  buildSkillCatalog: (snapshot: { allowedSlugs: string[] }) => snapshot.allowedSlugs.join(','),
}))
const { finalizeRuntimeResourcePreparation, createElectronAgentHost } = await import('../agent-runtime-host')
const { agentRuntimePolicyRuns } = await import('../agent-runtime-policy-snapshot')
const { __setMcpConnectionFactoryForTest, disconnectMcpServer } = await import('../adapters/pi-mcp-tools')
let connections: string[] = []
__setMcpConnectionFactoryForTest(async name => {
  connections.push(name)
  return { client: { listTools: async () => ({ tools: [{ name: 'inspect', description: 'fixture', inputSchema: { type: 'object' } }] }), close: async () => {} }, transport: { close: async () => {} } } as never
})
afterAll(async () => { await disconnectMcpServer('allowed'); await disconnectMcpServer('blocked'); __setMcpConnectionFactoryForTest(); agentRuntimePolicyRuns.clear() })
for (const runtime of ['claude', 'pi'] as const) for (const empty of [false, true]) {
  test(`${runtime} final executable whitelist ${empty ? 'empty' : 'intersection'}`, async () => {
    const sessionId = `${runtime}-${empty}`
    const preset: AgentPreset = { id: sessionId, name: sessionId, description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, skillSlugs: empty ? [] : ['allowed'], mcpServerNames: empty ? [] : ['allowed'] }
    agentRuntimePolicyRuns.resolveForRun(sessionId, { preset, presetReference: { presetId: sessionId, presetScope: 'user-global' } })
    connections = []
    const host = createElectronAgentHost()
    const result = await host.ports.queryPreparation!.prepare({ sessionId, runtime, prompt: 'fixture', prepared: { canUseTool: async () => ({ behavior: 'deny', message: 'fixture' }),
      resources: { mcpResources: [{ name: 'allowed', type: 'http' }, { name: 'blocked', type: 'http' }] },
      mcpServers: { allowed: { type: 'http', url: 'https://fixture.invalid' }, blocked: { type: 'http', url: 'https://fixture.invalid' } },
    } } as never, new AbortController().signal)
    if (runtime === 'claude') {
      expect(Object.keys(result.mcpServers ?? {})).toEqual(empty ? [] : ['allowed'])
      expect(result.skills).toEqual(empty ? [] : ['allowed'])
      expect(result.plugins).toEqual([{ type: 'local', path: empty ? '/fixture/policy/' : '/fixture/policy/allowed' }])
      expect(connections).toEqual([])
    } else {
      expect(result.mcpServers).toEqual({})
      expect((result.tools ?? []).map(tool => (tool as { name: string }).name)).toEqual(empty ? [] : ['mcp__allowed__inspect'])
      expect(result.resources?.skillCatalog).toBe(empty ? '' : 'allowed')
      expect(connections).not.toContain('blocked')
    }
    expect(result.prompt).not.toContain('blocked')
    if (empty) expect(result.prompt).not.toContain('MCP 服务器: allowed')
    expect(result.resources?.mcpResources).toEqual(empty ? [] : [{ name: 'allowed', type: 'http' }])
  })
}
test('missing snapshot never consumes prefilled execution resources', async () => {
  const result = await finalizeRuntimeResourcePreparation({ sessionId: 'missing', runtime: 'pi' } as never, { tools: [{ name: 'prefilled' }], skills: ['allowed'], plugins: [{ type: 'local', path: '/unsafe' }], mcpServers: { blocked: { type: 'http' } } })
  expect(result.tools).toEqual([])
  expect(result.plugins).toEqual([])
  expect(result.mcpServers).toEqual({})
})

test('disabled discovered MCP tool is not executable or advertised', async () => {
  const sessionId = 'disabled-tool'
  agentRuntimePolicyRuns.resolveForRun(sessionId, { preset: { id: sessionId, name: sessionId, description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, disabledTools: ['mcp__allowed__inspect'] }, presetReference: { presetId: sessionId, presetScope: 'user-global' } })
  const result = await finalizeRuntimeResourcePreparation({ sessionId, runtime: 'pi' } as never, { resources: { mcpResources: [{ name: 'allowed' }] }, mcpServers: { allowed: { type: 'http', url: 'https://fixture.invalid' } } })
  expect(result.tools).toEqual([])
  expect(result.resources?.mcpResources).toEqual([])
})

const { resolvePiPreparedToolAssembly } = await import('@profer/agent-provider-pi/pi-agent-adapter')
for (const prefilled of [false, true]) test(`host preparation preserves deferred assembly, prefilled=${prefilled}`, async () => {
  const sessionId = `deferred-${prefilled}`
  agentRuntimePolicyRuns.resolveForRun(sessionId, { preset: { id: sessionId, name: sessionId, description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, mcpServerNames: ['allowed'], disabledTools: ['forbidden'] }, presetReference: { presetId: sessionId, presetScope: 'user-global' } })
  let builds = 0
  const sdk = { fixture: true }
  const host = createElectronAgentHost({ toolAssembly: { build: async input => {
    builds++
    expect(input).toEqual({ sdk, context: { fixture: 'deferred' } })
    return { tools: [{ name: 'collaboration' }, { name: 'forbidden' }, { name: 'mcp__blocked__injected' }], collaborationAvailable: true }
  } } })
  const prepared = await host.ports.queryPreparation!.prepare({ sessionId, runtime: 'pi', prompt: 'fixture', deferredToolAssemblyContext: { fixture: 'deferred' }, prepared: {
    canUseTool: async () => ({ behavior: 'deny', message: 'fixture' }),
    ...(prefilled ? { tools: [{ name: 'preset' }, { name: 'forbidden' }, { name: 'mcp__blocked__injected' }] } : {}),
    resources: { mcpResources: [{ name: 'allowed', type: 'http' }] },
    mcpServers: { allowed: { type: 'http', url: 'https://fixture.invalid' } },
  } } as never, new AbortController().signal)
  expect(builds).toBe(0)
  if (!prefilled) expect(prepared.tools).toBeUndefined()
  const resolved = await resolvePiPreparedToolAssembly({ prepared } as never, sdk as never)
  expect(builds).toBe(prefilled ? 0 : 1)
  expect(resolved.prepared?.tools?.map(tool => (tool as { name: string }).name)).toEqual([prefilled ? 'preset' : 'collaboration', 'mcp__allowed__inspect'])
  if (!prefilled) expect(resolved.prepared?.collaborationAvailable).toBe(true)
  await resolvePiPreparedToolAssembly(resolved, sdk as never)
  expect(builds).toBe(prefilled ? 0 : 1)
})
