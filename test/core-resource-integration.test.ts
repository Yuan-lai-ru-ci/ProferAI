import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { AGENT_IPC_CHANNELS as C, AGENT_PRESET_IPC_CHANNELS as P, GLOBAL_SKILL_IPC_CHANNELS as G } from '../packages/shared/src/index'
import { createCoreAgentRuntime } from '../apps/core/src/runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from '../apps/core/src/server'
import { CoreClient } from '../apps/electron/src/main/lib/core-client'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-core-resource-chain-')))
const previous = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = join(root, 'isolated-desktop')
const { routeCoreResource } = await import('../apps/electron/src/main/lib/core-resource-routing')
const runtimes: ReturnType<typeof createCoreAgentRuntime>[] = []
const servers: ReturnType<typeof createCoreServer>[] = []
afterAll(async () => {
  for (const server of servers) await closeCoreServer(server)
  for (const runtime of runtimes) await runtime.shutdown()
  if (previous === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})
async function fixture(name: string) {
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: join(root, name), workspaceRoot: join(root, name, 'workspaces'), mockAgent: true })
  runtimes.push(runtime)
  const workspace = runtime.workspaces.createManaged('Same')
  const server = createCoreServer({ version: 'e2e-fixture', runtime, apiKey: 'fixture-only' }); servers.push(server)
  await listenCoreServer(server, '127.0.0.1', 0)
  const client = new CoreClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'fixture-only', reconnect: false })
  const scope = { targetId: name, generation: 1 }
  const snapshot = { ...scope, ownsBusinessData: true, capabilities: ['resources.manage'], client }
  const call = async (channel: string, ...args: unknown[]) => (await routeCoreResource(channel, [...args, { __proferCoreResourceScope: scope }], () => snapshot))?.result
  return { runtime, workspace, client, call }
}

test('实际Core资源链：IPC operation映射→鉴权Client→Core保存，工作区/全局常用操作同源且跨Core隔离', async () => {
  const a = await fixture('core-a'), b = await fixture('core-b')
  try {
    const slug = a.workspace.slug
    await a.call(C.CREATE_SKILL, slug, 'owned', 'Owned', 'fixture', 'body')
    expect(await a.call(C.GET_SKILLS, slug)).toMatchObject([{ slug: 'owned', enabled: true }])
    expect(await b.call(C.GET_SKILLS, slug)).toEqual([])
    await a.call(C.WRITE_SKILL_CONTENT, slug, 'owned', '---\nname: Owned\ndescription: saved\n---\nchanged')
    expect(await a.call(C.READ_SKILL_CONTENT, slug, 'owned')).toContain('changed')
    await a.call(C.TOGGLE_SKILL, slug, 'owned', false, '')
    expect(await a.call(C.GET_SKILLS, slug)).toMatchObject([{ slug: 'owned', enabled: false }])
    await a.call(C.DELETE_SKILL, slug, 'owned')
    expect(await a.call(C.GET_SKILLS, slug)).toEqual([])
    const p = await a.call(P.CREATE_PRESET, slug, { name: 'Workspace', description: '', basePresetId: 'minimal' }) as { id: string }
    await a.call(P.SET_DEFAULT_PRESET, slug, p.id)
    expect(await a.call(P.GET_DEFAULT_PRESET, slug)).toBe(p.id)
    expect(await b.call(P.GET_DEFAULT_PRESET, slug)).toBe('standard')
    await expect(a.call(P.SET_WORKSPACE_ENABLED, slug, p.id, false)).rejects.toThrow()
    await a.call(P.SET_DEFAULT_PRESET, slug, 'standard')
    await a.call(P.DELETE_PRESET, slug, p.id)
    const global = await a.call(P.CREATE_GLOBAL_PRESET, { name: 'Global', description: '' }) as { id: string }
    await a.call(P.UPDATE_GLOBAL_PRESET, global.id, {
      name: 'Renamed', promptSections: null, channelId: null, modelId: null,
      effort: null, permissionMode: null, allowSubagents: null, basePresetId: null,
    })
    expect(await a.call(P.LIST_GLOBAL_PRESETS)).toContainEqual(expect.objectContaining({ id: global.id, name: 'Renamed' }))
    await a.call(P.DISABLE_GLOBAL_IN_WORKSPACE, slug, { presetId: global.id, presetScope: 'user-global' })
    await a.call(P.DELETE_GLOBAL_PRESET, { presetId: global.id, presetScope: 'user-global' })
    expect(await a.call(P.LIST_GLOBAL_PRESETS)).not.toContainEqual(expect.objectContaining({ id: global.id }))
    const skill = await a.call(G.CREATE_USER, 'global-owned', 'Global Owned', 'fixture', 'body') as { skillId: string }
    expect(await a.call(G.READ, skill.skillId)).toContain('Global Owned')
    expect(await b.call(G.LIST)).toEqual([])
    expect(await a.call(C.TEST_MCP_SERVER, 'unconfigured', { type: 'stdio', enabled: true })).toMatchObject({ success: false, reason: 'command-missing' })
    expect(await a.call(C.GET_MCP_CONNECTION_STATUS)).toEqual([])
    expect(await a.call(C.RESTART_MCP_SERVER, 'unconfigured', slug)).toMatchObject({ ok: true })
  } finally { a.client.close(); b.client.close() }
})

test('Given 已补齐资源协议 When 经桌面路由执行跨工作区Skill与提升删除 Then 所有操作落在当前Core', async () => {
  const a = await fixture('resource-gaps')
  try {
    const from = a.workspace.slug, target = a.runtime.workspaces.createManaged('Target').slug
    await a.call(C.CREATE_SKILL, from, 'cross-skill', 'Cross', '', 'v1')
    expect(await a.call(C.GET_OTHER_WORKSPACE_SKILLS, target)).toMatchObject([{ workspaceSlug: from, skills: [{ slug: 'cross-skill' }] }])
    await a.call(C.IMPORT_SKILL_FROM_WORKSPACE, target, from, 'cross-skill')
    await a.call(C.WRITE_SKILL_CONTENT, from, 'cross-skill', '---\nname: Cross\nversion: 2.0.0\n---\nv2')
    await a.call(C.UPDATE_SKILL_FROM_SOURCE, target, 'cross-skill')
    expect(await a.call(C.READ_SKILL_CONTENT, target, 'cross-skill')).toContain('v2')
    const global = await a.call(C.PROMOTE_SKILL_TO_GLOBAL, target, 'cross-skill', [target], true) as { skillId: string }
    expect(await a.call(G.GET_DELETE_BLOCKERS, global.skillId)).toMatchObject({ references: expect.arrayContaining([expect.objectContaining({ workspaceSlug: target, blocksDeletion: true })]) })
    await expect(a.call(G.DELETE_USER, global.skillId, `delete:${global.skillId}`)).rejects.toThrow()
    await a.call(G.SET_ENABLED, from, global.skillId, false)
    await a.call(G.SET_ENABLED, target, global.skillId, false)
    await a.call(G.DELETE_USER, global.skillId, `delete:${global.skillId}`)
    expect(await a.call(G.LIST)).toEqual([])
    const preset = await a.call(P.CREATE_PRESET, from, { name: 'Promote me', description: '' }) as { id: string }
    expect(await a.call(P.PROMOTE_WORKSPACE_PRESET_TO_GLOBAL, from, preset.id, [target], true)).toMatchObject({ scope: 'user-global', name: 'Promote me' })
  } finally { a.client.close() }
})
