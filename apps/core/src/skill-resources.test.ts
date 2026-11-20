import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffectiveAgentPresetPolicy } from '@profer/shared'
import { prepareCoreWorkspaceSkills } from './skill-resources'
import { createCoreAgentRuntime } from './runtime'
import { createClaudeSdkDouble } from '../../../packages/agent-provider-claude/test-hosts/claude-sdk-double'
import { ModelRuntime, createScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-skills-'))
  const workspaceConfigDir = join(root, 'workspaces', 'fixture')
  await mkdir(join(workspaceConfigDir, 'skills', 'fixture-skill'), { recursive: true })
  await writeFile(join(workspaceConfigDir, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Harmless fixture for checking Core resource routing\n---\n\nSKILL_BODY_SENTINEL. Do not execute any external action.\n')
  return { root, workspaceConfigDir, config: { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') } }
}

test('Core工作区Skill按白名单与实际工具依赖投影，禁用项不复制或泄露', async () => {
  const f = await fixture()
  try {
    const policy = createEffectiveAgentPresetPolicy({ id: 'fixture', name: 'fixture', description: 'fixture', isBuiltin: false, createdAt: 0, updatedAt: 0, skillSlugs: ['fixture-skill'] }, { presetId: 'fixture', presetScope: 'workspace', workspaceSlug: 'fixture' })
    const input = { ...f, sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), policy, toolNames: ['Read'], prompt: '/skill:fixture-skill' }
    const result = await prepareCoreWorkspaceSkills(input)
    expect(result.loaded).toEqual(['fixture-skill'])
    expect(result.system).toContain('fixture-skill')
    expect(result.task).toContain('SKILL_BODY_SENTINEL')
    expect(await readdir(join(f.root, 'core-resources', input.sessionId, input.runId, 'skills'))).toEqual(['fixture-skill'])
    const disabled = createEffectiveAgentPresetPolicy({ id: 'none', name: 'none', description: 'fixture', isBuiltin: false, createdAt: 0, updatedAt: 0, skillSlugs: [] }, { presetId: 'none', presetScope: 'builtin-meta' })
    const denied = await prepareCoreWorkspaceSkills({ ...input, runId: crypto.randomUUID(), policy: disabled })
    expect(denied.system).toBe('')
    expect(denied.loaded).toEqual([])
    expect(denied.task).toContain('not-found')
    await writeFile(join(f.workspaceConfigDir, 'skills', 'fixture-skill', 'profer-routing.json'), JSON.stringify({ requiredTools: ['missing_tool'] }))
    await expect(prepareCoreWorkspaceSkills({ ...input, runId: crypto.randomUUID() })).rejects.toThrow('依赖不可用')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Claude Core同一共享Skill路由进入实际adapter的SDK查询', async () => {
  const f = await fixture()
  const sdk = createClaudeSdkDouble()
  const runtime = createCoreAgentRuntime({ ...f.config, channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] },
    { claude: { sdkLoader: async () => sdk.module, spawnProcess: sdk.spawnProcess } })
  try {
    const project = join(f.root, 'claude-project')
    await mkdir(join(project, '.profer', 'skills', 'fixture-skill'), { recursive: true })
    await writeFile(join(project, '.profer', 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Harmless Core Claude resource fixture\n---\n\nCORE_CLAUDE_SKILL_BODY_SENTINEL\n')
    const workspace = runtime.workspaces.bindProject({ rootPath: project }).workspace
    const session = runtime.sessions.create({ title: 'Claude skills', runtime: 'claude', workspaceId: workspace.id, channelId: 'offline', permissionMode: 'auto' })
    const handle = runtime.coordinator.run(runtime.createQuery(session, '/skill:fixture-skill inspect fixture'))
    const deadline = Date.now() + 2500
    while (!sdk.state.options && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    expect(sdk.state.options?.systemPrompt).toContain('<skill_catalog>')
    expect(sdk.state.options?.skills).toEqual([])
    expect(sdk.state.options?.plugins).toEqual([])
    const prompt = await sdk.nextPromptInput()
    expect(JSON.stringify(prompt)).toContain('CORE_CLAUDE_SKILL_BODY_SENTINEL')
    sdk.push({ type: 'result', subtype: 'success', session_id: 'fixture-sdk', terminal_reason: 'completed' })
    expect(await handle.promise).toEqual({ status: 'completed' })
  } finally {
    await runtime.shutdown(); sdk.dispose(); await rm(f.root, { recursive: true, force: true })
  }
})

test('Core Skill真实Pi请求中含摘要与显式正文，不需要模型联网', async () => {
  const f = await fixture()
  const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
  const original = { stream: prototype.stream, streamSimple: prototype.streamSimple }
  const transport = createScriptedTransport([{ textChunks: ['fixture done'] }])
  prototype.stream = transport.streamSimple; prototype.streamSimple = transport.streamSimple
  const runtime = createCoreAgentRuntime({ ...f.config, channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }] })
  try {
    // fixture目录不是已登记工作区；显式绑定项目目录，Core资源目录按项目.profer解析。
    const project = join(f.root, 'project')
    await mkdir(join(project, '.profer', 'skills', 'fixture-skill'), { recursive: true })
    await writeFile(join(project, '.profer', 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: Harmless fixture for Core skill injection\n---\n\nCORE_PI_SKILL_BODY_SENTINEL\n')
    const workspace = runtime.workspaces.bindProject({ rootPath: project }).workspace
    const session = runtime.sessions.create({ title: 'skills fixture', runtime: 'pi', workspaceId: workspace.id, channelId: 'offline', modelId: 'claude-sonnet-4-5' })
    const handle = runtime.coordinator.run(runtime.createQuery(session, '/skill:fixture-skill read the fixture only'))
    expect(await handle.promise).toEqual({ status: 'completed' })
    expect(transport.calls[0]?.systemPrompt).toContain('<skill_catalog>')
    expect(transport.calls[0]?.systemPrompt).toContain('fixture-skill')
    expect(transport.calls[0]?.userTexts.join('\n')).toContain('CORE_PI_SKILL_BODY_SENTINEL')
    expect(transport.calls[0]?.userTexts.join('\n')).toContain('/skill:fixture-skill read the fixture only')
  } finally {
    await runtime.shutdown(); prototype.stream = original.stream; prototype.streamSimple = original.streamSimple; transport.releasePending()
    await rm(f.root, { recursive: true, force: true })
  }
})
