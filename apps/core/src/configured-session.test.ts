import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 使用Core自己的设置与渠道，无凭据解析/模型调用，不加载桌面配置。
test('Core配置创建原子解析runtime/渠道模型/岗位，拒绝非法选择且不产生会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-configured-session-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [
      { id: 'pi', name: 'Pi', provider: 'anthropic' as const, apiKey: 'fixture', agentRuntimes: ['pi' as const], models: [{ id: 'pi-model', name: 'Pi model', enabled: true }] },
      { id: 'claude', name: 'Claude', provider: 'anthropic' as const, apiKey: 'fixture', agentRuntimes: ['claude' as const], models: [{ id: 'claude-model', name: 'Claude model', enabled: true }] },
      { id: 'disabled', name: 'Disabled', provider: 'anthropic' as const, apiKey: 'fixture', enabled: false, models: [{ id: 'off', name: 'off', enabled: true }] },
    ] }
  const settings = JSON.stringify({ agentRuntime: 'pi', agentChannelId: 'pi', agentModelId: 'pi-model' })
  await writeFile(join(root, 'settings.json'), settings)
  let runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const post = (path: string, body: object, auth = true) => fetch(`${base}${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(auth ? { authorization: 'Bearer fixture' } : {}),
  }, body: JSON.stringify(body) })
  try {
    const workspace = runtime.workspaces.createManaged('Owner')
    await writeFile(join(config.workspaceRoot, workspace.slug, 'agent-presets.json'), JSON.stringify({ presets: [
      { id: 'owner-preset', name: 'Owner', description: 'Configured session owner fixture', createdAt: 0, updatedAt: 0, permissionMode: 'plan', promptSections: [], skillSlugs: [], mcpServerNames: [] },
    ], defaultPresetId: 'owner-preset', defaultPresetReference: { presetId: 'owner-preset', presetScope: 'workspace', workspaceSlug: workspace.slug } }))
    expect((await post('/sessions/configured', {}, false)).status).toBe(401)
    const created = await post('/sessions/configured', { workspaceId: workspace.id, title: 'Pocket Core', permissionMode: 'bypassPermissions' })
    expect(created.status).toBe(201)
    const session = await created.json() as { id: string }
    expect(runtime.sessions.getMeta(session.id)).toMatchObject({ title: 'Pocket Core', workspaceId: workspace.id, agentRuntime: 'pi',
      channelId: 'pi', modelId: 'pi-model', presetId: 'owner-preset', permissionMode: 'plan' })
    const count = runtime.sessions.list().length
    // Given 已有合法工作区，When 省略或显式传入无效归属，Then 拒绝且不隐式绑定。
    for (const path of ['/sessions', '/sessions/configured']) {
      expect((await post(path, {})).status).toBeGreaterThanOrEqual(400)
      expect((await post(path, { workspaceId: 'missing' })).status).toBeGreaterThanOrEqual(400)
      expect(runtime.sessions.list()).toHaveLength(count)
    }
    for (const input of [
      { runtime: 'unsupported' }, { runtime: 'claude', channelId: 'pi' }, { channelId: 'missing' }, { channelId: 'disabled' },
      { channelId: 'pi', modelId: 'claude-model' }, { channelId: 'pi', modelId: 'missing' }, { workspaceId: 'missing' },
      { presetId: 'missing-preset' }, { permissionMode: 'allow' }, { modelId: 42 },
    ]) {
      const response = await post('/sessions/configured', { workspaceId: workspace.id, ...input })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(runtime.sessions.list()).toHaveLength(count)
    }
    const explicit = await post('/sessions/configured', { workspaceId: workspace.id, runtime: 'claude', channelId: 'claude', modelId: 'claude-model' })
    expect(explicit.status).toBe(201)
    expect(await explicit.json()).toMatchObject({ agentRuntime: 'claude', channelId: 'claude', modelId: 'claude-model' })
    // 没有保存运行时偏好时也遵循共享默认 Pi；显式 Claude 仍由上面的用例覆盖。
    await writeFile(join(root, 'settings.json'), '{}')
    const defaultCreated = await post('/sessions/configured', { workspaceId: workspace.id })
    expect(defaultCreated.status).toBe(201)
    expect(await defaultCreated.json()).toMatchObject({ agentRuntime: 'pi', channelId: 'pi', modelId: 'pi-model' })
    await writeFile(join(root, 'settings.json'), settings)
    const drafts = await Promise.all(Array.from({ length: 4 }, () => post('/project-draft-sessions/configured', { workspaceId: workspace.id })))
    const values = await Promise.all(drafts.map(response => response.json())) as Array<{ id: string }>
    expect(new Set(values.map(value => value.id)).size).toBe(1)
    expect(runtime.sessions.getMeta(values[0]!.id)).toMatchObject({ draft: true, agentRuntime: 'pi', channelId: 'pi', modelId: 'pi-model', presetId: 'owner-preset' })
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe(settings)
    await closeCoreServer(server); await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.sessions.getMeta(session.id)).toMatchObject({ workspaceId: workspace.id, agentRuntime: 'pi', channelId: 'pi', modelId: 'pi-model', permissionMode: 'plan' })
  } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)
