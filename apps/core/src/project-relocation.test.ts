import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, cp, symlink, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SDKMessage } from '@profer/shared'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 只移动本例创建的无害fixture；生产接口不移动、不复制、不清理用户数据。
test('项目重新定位只更新Core绑定，保留身份和消息，重启后使用新根', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-relocate-'))
  const config = { host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/workspaces/projects/relocate`
  const relocate = (id: string, rootPath: unknown, auth = true) => fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', ...(auth ? { authorization: 'Bearer fixture' } : {}),
  }, body: JSON.stringify({ id, rootPath }) })
  try {
    const oldRoot = join(root, 'original'), newRoot = join(root, 'moved'), emptyRoot = join(root, 'empty')
    await mkdir(oldRoot); await mkdir(emptyRoot)
    await writeFile(join(oldRoot, 'user.txt'), 'user fixture')
    const workspace = runtime.workspaces.bindProject({ rootPath: oldRoot, name: 'Keep name' }).workspace
    const session = runtime.sessions.create({ title: 'History', runtime: 'pi', workspaceId: workspace.id })
    runtime.sessions.appendMessages(session.id, [{ type: 'user', uuid: 'fixture-user', session_id: session.id, parent_tool_use_id: null,
      message: { role: 'user', content: 'saved fixture' } } as SDKMessage])
    const messages = runtime.sessions.readMessages(session.id)
    expect((await relocate(workspace.id, newRoot, false)).status).toBe(401)
    expect((await relocate(workspace.id, 3)).status).toBe(400)
    expect((await relocate(workspace.id, 'relative')).status).toBe(400)
    expect((await relocate(workspace.id, emptyRoot)).status).toBe(400)
    expect(runtime.workspaces.list()[0]?.rootPath).toBe(realpathSync(oldRoot))
    await writeFile(join(emptyRoot, '.profer'), 'not a directory')
    expect((await relocate(workspace.id, emptyRoot)).status).toBe(400)
    expect(await readFile(join(emptyRoot, '.profer'), 'utf8')).toBe('not a directory')
    await rm(join(emptyRoot, '.profer'))
    await symlink(join(oldRoot, '.profer'), join(emptyRoot, '.profer'), 'junction')
    expect((await relocate(workspace.id, emptyRoot)).status).toBe(400)
    await unlink(join(emptyRoot, '.profer'))
    const managed = runtime.workspaces.createManaged('Managed')
    expect((await relocate(managed.id, emptyRoot)).status).toBe(400)
    await cp(oldRoot, newRoot, { recursive: true })
    const owner = runtime.coordinator.ownership.claim({ sessionId: session.id, runtime: 'pi' })
    if (!owner.ok) throw new Error('fixture claim failed')
    try { expect((await relocate(workspace.id, newRoot)).status).toBe(400) } finally { runtime.coordinator.ownership.release(session.id, owner.owner.token) }
    const targetMessages = join(newRoot, '.profer', 'sessions', session.id, 'messages.jsonl')
    const saved = await readFile(targetMessages, 'utf8')
    await writeFile(targetMessages, 'conflicting fixture')
    expect((await relocate(workspace.id, newRoot)).status).toBe(400)
    await writeFile(targetMessages, saved)
    await rm(newRoot, { recursive: true })
    await rename(oldRoot, newRoot)
    let changes = 0
    const unlisten = runtime.subscribe(event => { if (event.type === 'workspace') changes++ })
    const response = await relocate(workspace.id, newRoot)
    unlisten()
    expect(changes).toBe(1)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ created: false, warnings: [], workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name, rootPath: realpathSync(newRoot) } })
    expect(runtime.createQuery(runtime.sessions.getMeta(session.id)!, 'fixture').cwd).toBe(realpathSync(newRoot))
    expect(runtime.sessions.readMessages(session.id)).toEqual(messages)
    expect(await readFile(join(newRoot, 'user.txt'), 'utf8')).toBe('user fixture')
    await closeCoreServer(server); await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.workspaces.list().find(item => item.id === workspace.id)?.rootPath).toBe(realpathSync(newRoot))
    expect(runtime.sessions.readMessages(session.id)).toEqual(messages)
    const conflict = runtime.workspaces.bindProject({ rootPath: emptyRoot, name: 'Other project' }).workspace
    expect(() => runtime.workspaces.relocateProject({ id: workspace.id, rootPath: conflict.rootPath! })).toThrow('已绑定')
  } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('重新定位拒绝旧原生资产、身份冲突和不完整任务图，不覆写目标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-relocate-conflict-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const oldRoot = join(root, 'old'), newRoot = join(root, 'new')
    await mkdir(oldRoot)
    const workspace = runtime.workspaces.bindProject({ rootPath: oldRoot }).workspace
    const session = runtime.sessions.create({ title: 'History', runtime: 'pi', workspaceId: workspace.id })
    runtime.sessions.appendMessages(session.id, [{ type: 'user', uuid: 'u', session_id: session.id, message: { role: 'user', content: 'fixture' } } as SDKMessage])
    const dir = join(oldRoot, '.profer', 'sessions', session.id)
    await writeFile(join(dir, `${session.id}-graph.jsonl`), 'graph fixture')
    await cp(oldRoot, newRoot, { recursive: true })
    const targetDir = join(newRoot, '.profer', 'sessions', session.id)
    await rm(join(targetDir, `${session.id}-graph.jsonl`))
    expect(() => runtime.workspaces.relocateProject({ id: workspace.id, rootPath: newRoot })).toThrow('资产')
    await writeFile(join(targetDir, `${session.id}-graph.jsonl`), 'graph fixture')
    const sidecar = join(targetDir, 'session.json')
    const original = await readFile(sidecar, 'utf8')
    await writeFile(sidecar, JSON.stringify({ ...session, id: 'different' }))
    expect(() => runtime.workspaces.relocateProject({ id: workspace.id, rootPath: newRoot })).toThrow('身份')
    expect(await readFile(sidecar, 'utf8')).toContain('different')
    await writeFile(sidecar, original)
    runtime.sessions.updateMeta(session.id, { piSessionFile: join(root, 'missing-native.jsonl') })
    expect(() => runtime.workspaces.relocateProject({ id: workspace.id, rootPath: newRoot })).toThrow('原生')
    expect(runtime.workspaces.list()[0]?.rootPath).toBe(realpathSync(oldRoot))
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)
