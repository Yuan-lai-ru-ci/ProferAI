import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'
import { createCoreAgentRuntime } from './runtime'

async function requestJson(port: number, path: string, options: { method?: string; body?: unknown; apiKey?: string } = {}): Promise<{ statusCode: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = request({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ statusCode: response.statusCode, body: body ? JSON.parse(body) : undefined }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('core server', () => {
  test('岗位与引擎修改由Core鉴权校验、拒绝旧版本与非法引用，并在重启后保留', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-binding-'))
    const config = { host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces'), mockAgent: true }
    let runtime = createCoreAgentRuntime(config)
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'fixture-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      const workspace = runtime.workspaces.createManaged('binding')
      const preset = { id: 'strict', name: 'strict', description: 'Strict preset fixture', version: '1', basePresetId: 'code', permissionMode: 'plan', createdAt: 1, updatedAt: 1 }
      await writeFile(join(config.workspaceRoot, workspace.slug, 'agent-presets.json'), JSON.stringify({ presets: [preset] }))
      const session = runtime.sessions.create({ title: 'empty', runtime: 'claude', workspaceId: workspace.id, permissionMode: 'bypassPermissions' })
      const patch = (body: object, authenticated = true) => requestJson(port, `/sessions/${session.id}`, { method: 'PATCH', body, ...(authenticated ? { apiKey: 'fixture-only' } : {}) })
      expect((await patch({ agentRuntime: 'pi' }, false)).statusCode).toBe(401)
      expect(await patch({ agentRuntime: 'unknown' })).toMatchObject({ statusCode: 400 })
      expect(await patch({ agentRuntime: 'pi', expectedRevision: 0 })).toMatchObject({ statusCode: 200, body: { agentRuntime: 'pi', revision: 1, agentRuntimeLocked: false } })
      expect(await patch({ agentRuntime: 'pi', expectedRevision: 1 })).toMatchObject({ statusCode: 200, body: { revision: 1 } })
      const owner = runtime.coordinator.ownership.claim({ sessionId: session.id, runtime: 'pi' })
      if (!owner.ok) throw new Error('fixture claim failed')
      expect(await patch({ agentRuntime: 'claude' })).toMatchObject({ statusCode: 400 })
      expect(await patch({ presetId: 'code' })).toMatchObject({ statusCode: 400 })
      runtime.coordinator.ownership.release(session.id, owner.owner.token)
      const strict = { presetId: 'strict', presetScope: 'workspace', workspaceSlug: workspace.slug, presetVersion: '1' }
      for (const body of [
        { presetId: 'missing' }, { presetId: '' }, { presetId: null }, { presetReference: null },
        { presetId: 'code', presetReference: strict }, { presetReference: { ...strict, workspaceSlug: 'another' } },
        { presetReference: { ...strict, presetVersion: 'old' } },
      ]) expect((await patch(body)).statusCode).toBe(400)
      expect(runtime.sessions.getMeta(session.id)?.revision).toBe(1)
      expect(await patch({ presetReference: strict, expectedRevision: 1 })).toMatchObject({ statusCode: 200, body: { presetId: 'strict', presetReference: strict, permissionMode: 'plan', revision: 2 } })
      expect(await patch({ presetId: 'code', expectedRevision: 1 })).toMatchObject({ statusCode: 400, body: { error: expect.stringContaining('REVISION_CONFLICT') } })
      // 放宽岗位不自动放宽会话权限；裸ID由Core解析成稳定引用。
      expect(await patch({ presetId: 'code', expectedRevision: 2 })).toMatchObject({ statusCode: 200, body: { presetId: 'code', presetReference: { presetId: 'code', presetScope: 'builtin-meta' }, permissionMode: 'plan', revision: 3 } })
      await writeFile(join(config.workspaceRoot, workspace.slug, 'agent-presets.json'), JSON.stringify({ presets: [preset], disabledWorkspacePresetIds: ['strict'] }))
      expect((await patch({ presetReference: strict })).statusCode).toBe(400)
      runtime.sessions.appendMessages(session.id, [{ type: 'user', uuid: 'fixture-user', session_id: session.id, parent_tool_use_id: null, message: { role: 'user', content: 'history' } }])
      expect(await patch({ agentRuntime: 'claude' })).toMatchObject({ statusCode: 400, body: { error: expect.stringContaining('内核已固定') } })
      const native = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'native', runtime: 'pi' })
      runtime.sessions.updateMeta(native.id, { sdkSessionId: 'existing-native' })
      const nativeChange = await requestJson(port, `/sessions/${native.id}`, { method: 'PATCH', apiKey: 'fixture-only', body: { agentRuntime: 'claude' } })
      expect(nativeChange).toMatchObject({ statusCode: 400 })
      const racing = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'racing', runtime: 'claude' })
      const results = await Promise.all(['pi', 'claude'].map(agentRuntime => requestJson(port, `/sessions/${racing.id}`, { method: 'PATCH', apiKey: 'fixture-only', body: { agentRuntime, presetId: 'code', expectedRevision: 0 } })))
      expect(results.filter(result => result.statusCode === 200)).toHaveLength(1)
      expect(results.filter(result => result.statusCode === 400)).toHaveLength(1)
      await closeCoreServer(server)
      await runtime.shutdown()
      runtime = createCoreAgentRuntime(config)
      expect(runtime.sessions.getMeta(session.id)).toMatchObject({ agentRuntime: 'pi', presetId: 'code', permissionMode: 'plan', revision: 3 })
    } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(configDir, { recursive: true, force: true }) }
  }, 20000)

  test('会话推理设置由Core校验、写入并在重启后保留', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-session-reasoning-'))
    const config = { host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces'), mockAgent: true }
    let runtime = createCoreAgentRuntime(config)
    const server = createCoreServer({ version: 'reasoning-test', runtime, apiKey: 'fixture-only' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'reasoning' })
    const patch = (body: object) => requestJson(port, `/sessions/${session.id}`, { method: 'PATCH', body, apiKey: 'fixture-only' })
    try {
      expect((await patch({ codexFastMode: 'yes' })).statusCode).toBe(400)
      expect((await patch({ openAIThinkingLevel: 'turbo' })).statusCode).toBe(400)
      expect((await patch({ agentEffort: 'xhigh' })).statusCode).toBe(400)
      expect((await patch({ title: ' ' })).statusCode).toBe(400)
      expect(await patch({ codexFastMode: true, openAIThinkingLevel: 'xhigh', agentEffort: 'max', title: '  Core title  ', expectedRevision: 0 }))
        .toMatchObject({ statusCode: 200, body: { codexFastMode: true, openAIThinkingLevel: 'xhigh', agentEffort: 'max', title: 'Core title', titleLockedAt: expect.any(Number), revision: 1 } })
      expect(await patch({ openAIThinkingLevel: null, agentEffort: null, expectedRevision: 1 }))
        .toMatchObject({ statusCode: 200, body: { openAIThinkingLevel: null, agentEffort: null, revision: 2 } })
      const owner = runtime.coordinator.ownership.claim({ sessionId: session.id, runtime: 'claude' })
      if (!owner.ok) throw new Error('fixture claim failed')
      try {
        for (const body of [{ codexFastMode: false }, { openAIThinkingLevel: 'low' }, { agentEffort: 'low' }]) {
          expect((await patch(body)).statusCode).toBe(400)
        }
        expect(await patch({ title: 'Running title', expectedRevision: 2, titleLockedAt: -1 }))
          .toMatchObject({ statusCode: 200, body: { title: 'Running title', titleLockedAt: expect.any(Number), revision: 3 } })
        expect(runtime.sessions.getMeta(session.id)?.titleLockedAt).toBeGreaterThan(0)
        expect((await patch({ title: 'Stale title', expectedRevision: 2 })).statusCode).toBe(400)
      } finally { runtime.coordinator.ownership.release(session.id, owner.owner.token) }
      await closeCoreServer(server)
      await runtime.shutdown()
      runtime = createCoreAgentRuntime(config)
      expect(runtime.sessions.getMeta(session.id)).toMatchObject({ codexFastMode: true, openAIThinkingLevel: null, agentEffort: null, title: 'Running title', titleLockedAt: expect.any(Number), revision: 3 })
    } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(configDir, { recursive: true, force: true }) }
  }, 20000)

  test('serves health and rejects unknown routes', async () => {
    const server = createCoreServer({ version: 'test-version' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port

    try {
      await expect(requestJson(port, '/health')).resolves.toEqual({
        statusCode: 200,
        body: { status: 'ok', service: 'profer-core', version: 'test-version' },
      })
      await expect(requestJson(port, '/unknown')).resolves.toEqual({ statusCode: 404, body: { error: 'not_found' } })
    } finally {
      await closeCoreServer(server)
    }

    expect(server.listening).toBe(false)
  })

  test('returns an authenticated stable Core identity and declared capabilities', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-identity-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces') })
    const server = createCoreServer({ version: 'identity-test', runtime, apiKey: 'identity-secret', coreId: 'ubuntu-staging' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      await expect(requestJson(port, '/identity')).resolves.toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
      const response = await requestJson(port, '/identity', { apiKey: 'identity-secret' })
      expect(response).toEqual({ statusCode: 200, body: {
        protocolVersion: 1, coreId: 'ubuntu-staging', version: 'identity-test', platform: process.platform,
        hostCapabilities: (await import('./host-capabilities')).CORE_HOST_CAPABILITIES,
        capabilities: ['sessions.read', 'sessions.write', 'workspaces.read', 'workspaces.write', 'agent.pi', 'agent.events', 'agent.stop', 'planning', 'automation', 'delegation', 'agent.events.resume', 'resources.manage', 'chat'],
      } })
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('serves authenticated workspace list and project binding APIs', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-workspace-api-'))
    const workspaceRoot = join(configDir, 'workspaces')
    const projectRoot = join(configDir, 'linux-project')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(projectRoot))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot })
    const server = createCoreServer({ version: 'workspace-test', runtime, apiKey: 'workspace-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      await expect(requestJson(port, '/workspaces')).resolves.toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
      const created = await requestJson(port, '/workspaces/projects', {
        method: 'POST', apiKey: 'workspace-secret', body: { rootPath: projectRoot, name: 'Remote project' },
      })
      expect(created.statusCode).toBe(201)
      expect(created.body).toMatchObject({ created: true, workspace: { name: 'Remote project', storageMode: 'project', rootPath: realpathSync(projectRoot) } })
      const listed = await requestJson(port, '/workspaces', { apiKey: 'workspace-secret' })
      expect(listed).toMatchObject({ statusCode: 200, body: { workspaces: [expect.objectContaining({ name: 'Remote project' })] } })
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('persists remote channels encrypted and never returns credentials from HTTP', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-channels-'))
    const secret = 'remote-api-key-do-not-return'
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces') })
    const server = createCoreServer({ version: 'channel-test', runtime, apiKey: 'channel-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      const discover = await requestJson(port, '/channels/discover', { method: 'POST', apiKey: 'channel-secret', body: { provider: 'openai-codex', baseUrl: '', apiKey: '' } })
      expect(discover).toMatchObject({ statusCode: 200, body: { success: false, models: [] } })
      await expect(requestJson(port, '/channels/discover', { method: 'POST', body: { provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'ignored' } })).resolves.toMatchObject({ statusCode: 401 })
      const created = await requestJson(port, '/channels', { method: 'POST', apiKey: 'channel-secret', body: {
        id: 'remote-test', name: 'Remote test', provider: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: secret,
        enabled: true, models: [{ id: 'm1', name: 'Model One', enabled: true }],
      } })
      expect(created.statusCode).toBe(201)
      expect(JSON.stringify(created.body)).not.toContain(secret)
      expect(created.body).toMatchObject({ name: 'Remote test', models: [{ id: 'm1' }] })
      const createdId = (created.body as { id: string }).id
      expect(createdId).toBeTruthy()
      const files = await import('node:fs/promises').then(({ readdir, readFile }) => readdir(configDir, { withFileTypes: true }).then(async entries => Promise.all(entries.filter(entry => entry.isFile()).map(entry => readFile(join(configDir, entry.name))))))
      expect(Buffer.concat(files).includes(Buffer.from(secret))).toBe(false)
      const persisted = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces') })
      expect(persisted.listChannelConfigs()).toMatchObject([{ id: createdId, apiKey: secret, name: 'Remote test' }])
      persisted.dispose()
      const updated = await requestJson(port, `/channels/${createdId}`, { method: 'PATCH', apiKey: 'channel-secret', body: { name: 'Updated' } })
      expect(updated.body).toMatchObject({ id: createdId, name: 'Updated' })
      expect(await requestJson(port, `/channels/${createdId}`, { method: 'DELETE', apiKey: 'channel-secret' })).toMatchObject({ statusCode: 204 })
      expect((await requestJson(port, '/channels', { apiKey: 'channel-secret' })).body).toEqual({ channels: [] })
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('ensures one authenticated workspace session and reuses it on repeated requests', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-workspace-session-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces') })
    const server = createCoreServer({ version: 'workspace-session-test', runtime, apiKey: 'workspace-session-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      const workspace = await requestJson(port, '/workspaces', { method: 'POST', apiKey: 'workspace-session-secret', body: { name: 'Remote workspace' } })
      const workspaceId = (workspace.body as { id: string }).id
      const input = { workspaceId, channelId: 'deepseek', modelId: 'deepseek-chat' }
      const [first, concurrent] = await Promise.all([
        requestJson(port, '/workspace-sessions', { method: 'POST', apiKey: 'workspace-session-secret', body: input }),
        requestJson(port, '/workspace-sessions', { method: 'POST', apiKey: 'workspace-session-secret', body: input }),
      ])
      expect(first.statusCode).toBe(200)
      expect(concurrent.statusCode).toBe(200)
      expect(first.body).toMatchObject({ agentRuntime: 'pi', workspaceId, channelId: 'deepseek', modelId: 'deepseek-chat' })
      expect((first.body as { id: string }).id).toBe((concurrent.body as { id: string }).id)
      const ordinary = await requestJson(port, '/sessions', { method: 'POST', apiKey: 'workspace-session-secret', body: { title: 'Another session', ...input } })
      expect(ordinary.statusCode).toBe(201)
      expect(ordinary.body).toMatchObject({ title: 'Another session', workspaceId })
      expect((first.body as { id: string }).id).not.toBe((ordinary.body as { id: string }).id)
      expect((await requestJson(port, '/sessions', { apiKey: 'workspace-session-secret' })).body).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ id: (first.body as { id: string }).id }), expect.objectContaining({ id: (ordinary.body as { id: string }).id })]) })
      await expect(requestJson(port, '/workspace-sessions', { method: 'POST', apiKey: 'workspace-session-secret', body: { workspaceId: 'missing' } })).resolves.toMatchObject({ statusCode: 404, body: { error: 'workspace_not_found' } })
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('resolves workspace cwd without recreating or falling back from an invalid project root', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-workspace-cwd-'))
    const workspaceRoot = join(configDir, 'workspaces')
    const projectRoot = join(configDir, 'linux-project')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(projectRoot))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot })
    try {
      const project = runtime.workspaces.bindProject({ rootPath: projectRoot, name: 'Project' }).workspace
      const projectSession = runtime.sessions.create({ title: 'Project session', runtime: 'pi', workspaceId: project.id })
      expect(runtime.createQuery(projectSession, 'hello').cwd).toBe(realpathSync(projectRoot))

      const managed = runtime.workspaces.createManaged('Managed')
      const managedSession = runtime.sessions.create({ title: 'Managed session', runtime: 'pi', workspaceId: managed.id })
      expect(runtime.createQuery(managedSession, 'hello').cwd).toBe(join(workspaceRoot, managed.slug))

      const canonicalProjectRoot = realpathSync(projectRoot)
      await import('node:fs/promises').then(({ rm }) => rm(projectRoot, { recursive: true }))
      expect(() => runtime.createQuery(projectSession, 'hello')).toThrow(`Core 项目工作区根目录不存在：${canonicalProjectRoot}`)
      expect(await import('node:fs/promises').then(({ stat }) => stat(projectRoot).then(() => true, () => false))).toBe(false)

      const nonDirectoryRoot = join(configDir, 'not-a-directory')
      await import('node:fs/promises').then(({ mkdir }) => mkdir(nonDirectoryRoot))
      const nonDirectoryWorkspace = runtime.workspaces.bindProject({ rootPath: nonDirectoryRoot, name: 'Not a directory' }).workspace
      const nonDirectorySession = runtime.sessions.create({ title: 'Invalid project session', runtime: 'pi', workspaceId: nonDirectoryWorkspace.id })
      const canonicalNonDirectoryRoot = realpathSync(nonDirectoryRoot)
      await import('node:fs/promises').then(async ({ rm, writeFile }) => {
        await rm(nonDirectoryRoot, { recursive: true })
        await writeFile(nonDirectoryRoot, 'file')
      })
      expect(() => runtime.createQuery(nonDirectorySession, 'hello')).toThrow(`Core 项目工作区根路径不是目录：${canonicalNonDirectoryRoot}`)

      const orphanedSession = runtime.sessions.create({ title: 'Orphaned session', runtime: 'pi', workspaceId: managed.id })
      runtime.sessions.updateMeta(orphanedSession.id, { workspaceId: 'missing-workspace' })
      expect(() => runtime.createQuery(runtime.sessions.getMeta(orphanedSession.id)!, 'hello')).toThrow('Core 工作区不存在：missing-workspace')
    } finally {
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('桌面索引新工作区立即用于查询，项目根失效不创建目录或回退', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-desktop-cwd-'))
    const workspaceRoot = join(configDir, 'agent-workspaces')
    const desktopWorkspaceIndexPath = join(configDir, 'agent-workspaces.json')
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot, desktopWorkspaceIndexPath })
    const fs = await import('node:fs/promises')
    try {
      const managed = { id: 'desktop-managed', name: 'Desktop', slug: 'desktop', createdAt: 1, updatedAt: 1 }
      const projectRoot = join(configDir, 'project')
      await fs.mkdir(projectRoot)
      const project = { ...managed, id: 'desktop-project', slug: 'project', storageMode: 'project', rootPath: projectRoot }
      const writeIndex = (workspaces: unknown[]) => fs.writeFile(desktopWorkspaceIndexPath, JSON.stringify({ version: 4, workspaces }))
      await writeIndex([managed, project])
      const managedSession = runtime.sessions.create({ title: 'Desktop managed', runtime: 'pi', workspaceId: managed.id })
      expect(runtime.createQuery(managedSession, 'hello').cwd).toBe(join(workspaceRoot, managed.slug))
      const projectSession = runtime.sessions.create({ title: 'Desktop project', runtime: 'pi', workspaceId: project.id })
      expect(runtime.createQuery(projectSession, 'hello').cwd).toBe(projectRoot)
      const added = { ...managed, id: 'new-managed', slug: 'new-managed' }
      await writeIndex([managed, project, added])
      expect(runtime.createQuery(runtime.sessions.create({ title: 'Desktop added', runtime: 'pi', workspaceId: added.id }), 'hello').cwd).toBe(join(workspaceRoot, added.slug))
      await fs.rm(projectRoot, { recursive: true })
      expect(() => runtime.createQuery(projectSession, 'hello')).toThrow('根目录不存在')
      expect(await fs.stat(projectRoot).then(() => true, () => false)).toBe(false)
      await writeIndex([{ ...project, rootPath: 'relative/path' }])
      expect(() => runtime.createQuery(projectSession, 'hello')).toThrow('根目录无效')
      expect(await fs.stat(join(configDir, 'workspaces.json')).then(() => true, () => false)).toBe(false)
    } finally {
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('creates Pi sessions with an explicit channel', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-pi-test-'))
    const runtime = createCoreAgentRuntime({
      host: '127.0.0.1',
      port: 0,
      configDir,
      workspaceRoot: join(configDir, 'workspaces'),
      channels: [{ id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', apiKey: 'test-key' }],
    })
    const server = createCoreServer({ version: 'test-version', runtime, apiKey: 'test-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port

    try {
      const created = await requestJson(port, '/sessions', {
        method: 'POST',
        apiKey: 'test-secret',
        body: { workspaceId: runtime.workspaces.createManaged('测试工作区').id, title: 'Pi session', runtime: 'pi', channelId: 'deepseek', modelId: 'deepseek-chat' },
      })
      expect(created.statusCode).toBe(201)
      expect(created.body).toEqual(expect.objectContaining({ agentRuntime: 'pi', channelId: 'deepseek', modelId: 'deepseek-chat' }))
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('session permission mode is accepted on create and patch and persists across restart', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-session-permission-'))
    const workspaceRoot = join(configDir, 'workspaces')
    let runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot })
    const server = createCoreServer({ version: 'test-version', runtime, apiKey: 'test-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      const created = await requestJson(port, '/sessions', { method: 'POST', apiKey: 'test-secret', body: { workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'Permission mode', permissionMode: 'auto' } })
      expect(created).toMatchObject({ statusCode: 201, body: { permissionMode: 'auto' } })
      const sessionId = (created.body as { id: string }).id
      expect(await requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', apiKey: 'test-secret', body: { permissionMode: 'plan', expectedRevision: 0 } })).toMatchObject({ statusCode: 200, body: { permissionMode: 'plan', revision: 1 } })
      expect(await requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', apiKey: 'test-secret', body: { permissionMode: 'bypassPermissions', expectedRevision: 0 } })).toMatchObject({ statusCode: 400, body: { error: expect.stringContaining('REVISION_CONFLICT') } })
      expect(runtime.sessions.getMeta(sessionId)).toMatchObject({ permissionMode: 'plan', revision: 1 })
      const racing = await Promise.all(['auto', 'bypassPermissions'].map(permissionMode => requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', apiKey: 'test-secret', body: { permissionMode, expectedRevision: 1 } })))
      expect(racing.filter(result => result.statusCode === 200)).toHaveLength(1)
      expect(racing.filter(result => result.statusCode === 400)).toHaveLength(1)
      const authoritative = runtime.sessions.getMeta(sessionId)!
      expect(authoritative.revision).toBe(2)
      await closeCoreServer(server)
      runtime.dispose()
      runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot })
      expect(runtime.sessions.getMeta(sessionId)).toMatchObject({ permissionMode: authoritative.permissionMode, revision: 2 })
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('updates authenticated session model and preset metadata and persists it across restart', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-session-meta-'))
    const workspaceRoot = join(configDir, 'workspaces')
    const channels = [{ id: 'channel-1', name: 'fixture', provider: 'anthropic' as const, apiKey: 'fixture', models: [{ id: 'model-1', name: 'model', enabled: true }] }]
    let runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot, channels })
    const server = createCoreServer({ version: 'test-version', runtime, apiKey: 'test-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    try {
      const created = await requestJson(port, '/sessions', { method: 'POST', apiKey: 'test-secret', body: { workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'Settings test' } })
      const sessionId = (created.body as { id: string }).id
      expect(await requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', apiKey: 'test-secret', body: { channelId: 'missing', modelId: 'model-1' } })).toMatchObject({ statusCode: 400, body: { error: '渠道不可用或不存在' } })
      expect(await requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', apiKey: 'test-secret', body: { channelId: 'channel-1', modelId: 'missing' } })).toMatchObject({ statusCode: 400, body: { error: '模型不属于当前渠道或未启用' } })
      const patch = { channelId: 'channel-1', modelId: 'model-1', presetId: 'standard', presetReference: { presetId: 'standard', presetScope: 'builtin-meta' } }
      expect(await requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', body: patch })).toMatchObject({ statusCode: 401 })
      expect(await requestJson(port, `/sessions/${sessionId}`, { method: 'PATCH', apiKey: 'test-secret', body: patch })).toMatchObject({
        statusCode: 200, body: { channelId: 'channel-1', modelId: 'model-1', presetId: 'standard', presetReference: patch.presetReference, revision: 1 },
      })
      await closeCoreServer(server)
      runtime.dispose()
      runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot, channels })
      expect(runtime.sessions.list()).toContainEqual(expect.objectContaining({ id: sessionId, ...patch, revision: 1 }))
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('round-trips Unicode workspace names through authenticated HTTP and persisted storage', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-unicode-workspace-'))
    const workspaceRoot = join(configDir, 'workspaces')
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot })
    const server = createCoreServer({ version: 'test-version', runtime, apiKey: 'test-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const name = '中文远程工作区-项目'

    try {
      const created = await requestJson(port, '/workspaces', { method: 'POST', apiKey: 'test-secret', body: { name } })
      expect(created).toMatchObject({ statusCode: 201, body: { name } })
      expect(await requestJson(port, '/workspaces', { apiKey: 'test-secret' })).toMatchObject({
        statusCode: 200,
        body: { workspaces: [expect.objectContaining({ name })] },
      })
      runtime.dispose()
      const restartedRuntime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot })
      expect(restartedRuntime.workspaces.list()).toEqual([expect.objectContaining({ name })])
      restartedRuntime.dispose()
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('requires bearer auth and persists created sessions', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'profer-core-test-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir, workspaceRoot: join(configDir, 'workspaces') })
    const server = createCoreServer({ version: 'test-version', runtime, apiKey: 'test-secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port

    try {
      await expect(requestJson(port, '/sessions')).resolves.toEqual({ statusCode: 401, body: { error: 'unauthorized' } })
      const createdWorkspace = await requestJson(port, '/workspaces', { method: 'POST', apiKey: 'test-secret', body: { name: 'Linux managed' } })
      expect(createdWorkspace.statusCode).toBe(201)
      expect(createdWorkspace.body).toMatchObject({ name: 'Linux managed', storageMode: 'managed' })
      await expect(requestJson(port, '/workspaces', { apiKey: 'test-secret' })).resolves.toMatchObject({
        statusCode: 200,
        body: { workspaces: [expect.objectContaining({ name: 'Linux managed' })] },
      })
      await expect(requestJson(port, '/workspaces')).resolves.toMatchObject({ statusCode: 401, body: { error: 'unauthorized' } })

      const created = await requestJson(port, '/sessions', { method: 'POST', apiKey: 'test-secret', body: { workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'Ubuntu session', cwd: configDir } })
      expect(created.statusCode).toBe(201)
      const session = created.body as { id: string; title: string }
      expect(session.title).toBe('Ubuntu session')
      await expect(requestJson(port, '/sessions', { apiKey: 'test-secret' })).resolves.toEqual({ statusCode: 200, body: { sessions: [expect.objectContaining({ id: session.id })] } })
    } finally {
      await closeCoreServer(server)
      runtime.dispose()
      await rm(configDir, { recursive: true, force: true })
    }
  })
})
