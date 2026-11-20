import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

// 只使用临时文件和临时Core；HTTP客户端提交的candidateBasePaths不能扩大授权。
test('Core文件读取按所属会话授权，project/managed搜索与预览不串读或链接逃逸', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-files-'))
  const config = { host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  const runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const api = (session: string, path: string, auth = true) => fetch(`${base}/sessions/${session}/files/${path}`, { headers: auth ? { authorization: 'Bearer fixture-only' } : {} })
  try {
    const projectRoot = join(root, 'project'), outside = join(root, 'outside')
    await mkdir(projectRoot); await mkdir(outside)
    const workspace = runtime.workspaces.bindProject({ rootPath: projectRoot }).workspace
    const session = runtime.sessions.create({ title: 'files', runtime: 'pi', workspaceId: workspace.id })
    const other = runtime.sessions.create({ title: 'other', runtime: 'pi', workspaceId: workspace.id })
    await writeFile(join(projectRoot, 'report.txt'), '中文 report')
    await writeFile(join(projectRoot, '.profer', 'mcp.json'), 'PRIVATE_CONFIG')
    await writeFile(join(outside, 'secret.txt'), 'PRIVATE_OUTSIDE')
    const attached = join(outside, 'attached.txt')
    await writeFile(attached, 'allowed attached file')
    await mkdir(join(projectRoot, '.profer', 'sessions', other.id), { recursive: true })
    const otherFile = join(projectRoot, '.profer', 'sessions', other.id, 'other.txt')
    await writeFile(otherFile, 'PRIVATE_OTHER_SESSION')
    const ownFile = join(projectRoot, '.profer', 'sessions', session.id, 'own.txt')
    await writeFile(ownFile, 'own data')
    expect((await api(session.id, 'search?query=report', false)).status).toBe(401)
    expect(await (await api(session.id, 'search?query=report')).json()).toMatchObject({ entries: [expect.objectContaining({ name: 'report.txt' })] })
    const result = await (await api(session.id, 'read?path=report.txt')).json() as { resolvedPath: string; base64: string; mime: string; version: { hash: string; size: number } }
    expect(result.resolvedPath).toBe(realpathSync(join(projectRoot, 'report.txt')))
    expect(Buffer.from(result.base64, 'base64').toString('utf8')).toBe('中文 report')
    expect(result.version.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.version.size).toBe(Buffer.byteLength('中文 report'))
    for (const path of [join(outside, 'secret.txt'), '../outside/secret.txt', otherFile, '.profer/mcp.json']) {
      expect((await api(session.id, `read?path=${encodeURIComponent(path)}&candidateBasePaths=${encodeURIComponent(outside)}`)).status).toBe(404)
    }
    expect((await api(session.id, `read?path=${encodeURIComponent(ownFile)}`)).status).toBe(200)
    await symlink(join(outside, 'secret.txt'), join(projectRoot, 'escape.txt'), 'file')
    expect((await api(session.id, 'read?path=escape.txt')).status).toBe(404)
    expect(JSON.stringify(await (await api(session.id, 'search?query=escape')).json())).not.toContain('escape.txt')
    await unlink(join(projectRoot, 'escape.txt'))
    runtime.sessions.updateMeta(session.id, { attachedFiles: [attached] })
    expect((await api(session.id, `read?path=${encodeURIComponent(attached)}`)).status).toBe(200)
    expect((await api(session.id, `read?path=${encodeURIComponent(join(outside, 'secret.txt'))}`)).status).toBe(404)
    const managed = runtime.workspaces.createManaged('Managed')
    const managedSession = runtime.sessions.create({ title: 'managed files', runtime: 'pi', workspaceId: managed.id })
    const managedOther = runtime.sessions.create({ title: 'managed other', runtime: 'pi', workspaceId: managed.id })
    const managedRoot = join(config.workspaceRoot, managed.slug)
    await mkdir(join(managedRoot, managedSession.id), { recursive: true }); await mkdir(join(managedRoot, managedOther.id), { recursive: true })
    await writeFile(join(managedRoot, managedSession.id, 'a.txt'), 'managed own')
    await writeFile(join(managedRoot, managedOther.id, 'b.txt'), 'managed other')
    await writeFile(join(managedRoot, 'config.json'), JSON.stringify({ attachedFiles: [attached] }))
    expect((await api(managedSession.id, 'read?path=a.txt')).status).toBe(200)
    expect((await api(managedSession.id, `read?path=${encodeURIComponent(join(managedRoot, managedOther.id, 'b.txt'))}`)).status).toBe(404)
    expect((await api(managedSession.id, `read?path=${encodeURIComponent(join(managedRoot, 'config.json'))}`)).status).toBe(404)
    expect((await api(managedSession.id, `read?path=${encodeURIComponent(attached)}`)).status).toBe(200)
    await symlink(outside, join(managedRoot, managedSession.id, 'linked'), 'junction')
    expect((await api(managedSession.id, 'read?path=linked/secret.txt')).status).toBe(404)
    expect(JSON.stringify(await (await api(managedSession.id, 'search?query=secret')).json())).not.toContain('secret.txt')
    await unlink(join(managedRoot, managedSession.id, 'linked'))
    expect((await api('missing', 'read?path=report.txt')).status).toBeGreaterThanOrEqual(400)
    await runtime.deletions.request(managedOther.id)
    expect((await api(managedOther.id, 'read?path=b.txt')).status).toBeGreaterThanOrEqual(400)
    await rm(projectRoot, { recursive: true })
    expect((await api(session.id, 'read?path=report.txt')).status).toBeGreaterThanOrEqual(400)
    expect((await api(session.id, 'search?query=report')).status).toBeGreaterThanOrEqual(400)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('PRIVATE_OUTSIDE')
  } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)
