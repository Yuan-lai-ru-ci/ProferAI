import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 只在临时 Core 中验证原子 ensure，不扫描桌面目录、不调用模型。
test('Core项目草稿原子创建、重启复用、首条输入晋升和归属保护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-draft-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  await writeFile(join(root, 'settings.json'), JSON.stringify({ agentRuntime: 'pi' }))
  let runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'draft-test', runtime, apiKey: 'fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as { port: number }).port
  const ensure = (body: unknown, authenticated = true): Promise<{ status: number; body: Record<string, unknown> }> => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({ hostname: '127.0.0.1', port, path: '/project-draft-sessions', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(authenticated ? { authorization: 'Bearer fixture-only' } : {}),
    } }, response => {
      let data = ''
      response.on('data', chunk => { data += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject); req.end(payload)
  })
  try {
    const workspace = runtime.workspaces.createManaged('draft owner')
    const ordinary = runtime.sessions.create({ title: 'ordinary', workspaceId: workspace.id, runtime: 'pi' })
    expect((await ensure({ workspaceId: workspace.id }, false)).status).toBe(401)
    expect((await ensure({ workspaceId: 'missing' })).status).toBe(404)
    expect((await ensure({ workspaceId: workspace.id, modelId: 12 })).status).toBe(400)
    const requests = await Promise.all(Array.from({ length: 6 }, () => ensure({ workspaceId: workspace.id, channelId: 'first', modelId: 'original' })))
    expect(requests.every(item => item.status === 200)).toBe(true)
    const first = requests[0]!.body
    expect(first).toMatchObject({ draft: true, agentRuntime: 'pi', agentRuntimeLocked: false, channelId: 'first', modelId: 'original', workspaceId: workspace.id, presetId: 'standard' })
    expect(new Set(requests.map(item => item.body.id)).size).toBe(1)
    expect(first.id).not.toBe(ordinary.id)
    expect(runtime.sessions.list().filter(item => item.draft)).toHaveLength(1)
    expect((await ensure({ workspaceId: workspace.id, channelId: 'new', modelId: 'other' })).body).toEqual(first)
    await closeCoreServer(server)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    const restored = runtime.ensureProjectDraftSession({ workspaceId: workspace.id })
    expect(first).toEqual({ ...restored })
    // assistant/system 等异常记录不应让草稿晋升。
    runtime.sessions.appendMessages(restored.id, [{ type: 'system', subtype: 'fixture', uuid: 'fixture-system' } as unknown as SDKMessage])
    expect(runtime.ensureProjectDraftSession({ workspaceId: workspace.id }).draft).toBe(true)
    runtime.sessions.updateMeta(restored.id, { presetReference: { presetId: 'missing-fixture-preset', presetScope: 'user-global' } })
    expect((await runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(restored.id)!, 'rejected input')).promise).status).toBe('failed')
    expect(runtime.sessions.getMeta(restored.id)?.draft).toBe(true)
    expect(runtime.sessions.readMessages(restored.id).some(message => message.type === 'user')).toBe(false)
    runtime.sessions.updateMeta(restored.id, { presetReference: { presetId: 'standard', presetScope: 'builtin-meta' } })
    const outcome = await runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(restored.id)!, 'first actual input')).promise
    expect(outcome.status).toBe('completed')
    expect(runtime.sessions.getMeta(restored.id)?.draft).toBe(false)
    expect(runtime.sessions.readMessages(restored.id).some(message => message.type === 'user')).toBe(true)
    const next = runtime.ensureProjectDraftSession({ workspaceId: workspace.id })
    expect(next.id).not.toBe(restored.id)
    expect(next.draft).toBe(true)
    // 兼容持久化输入后未完成晋升的旧草稿；此次返回已晋升记录，下一次创建新草稿。
    runtime.sessions.appendMessages(next.id, [{ type: 'user', uuid: 'persisted-user', session_id: next.id, parent_tool_use_id: null,
      message: { role: 'user', content: 'already saved' } } as SDKMessage])
    expect(runtime.ensureProjectDraftSession({ workspaceId: workspace.id })).toMatchObject({ id: next.id, draft: false })
    const third = runtime.ensureProjectDraftSession({ workspaceId: workspace.id })
    runtime.sessions.updateMeta(third.id, { archived: true })
    const fourth = runtime.ensureProjectDraftSession({ workspaceId: workspace.id })
    expect(fourth.id).not.toBe(third.id)
    await runtime.deletions.request(fourth.id)
    expect(runtime.ensureProjectDraftSession({ workspaceId: workspace.id }).id).not.toBe(fourth.id)
    const other = runtime.workspaces.createManaged('other owner')
    expect(runtime.ensureProjectDraftSession({ workspaceId: other.id }).workspaceId).toBe(other.id)
    const projectRoot = join(root, 'project')
    await mkdir(projectRoot)
    const project = runtime.workspaces.bindProject({ rootPath: projectRoot }).workspace
    await rm(projectRoot, { recursive: true })
    const before = runtime.sessions.list().length
    expect(() => runtime.ensureProjectDraftSession({ workspaceId: project.id })).toThrow('根目录不存在')
    expect(runtime.sessions.list()).toHaveLength(before)
  } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 25000)
