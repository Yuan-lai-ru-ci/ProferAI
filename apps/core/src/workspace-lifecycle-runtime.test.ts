import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, unlink, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { createCoreAgentRuntime } from './runtime'
import { CoreWorkspaceOperationStore } from './workspace-operation-store'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

function json(port: number, path: string, method: string, body?: object, auth = true): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const req = request({ host: '127.0.0.1', port, path, method, headers: {
      ...(auth ? { authorization: 'Bearer fixture-only' } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    } }, response => {
      let data = ''
      response.on('data', chunk => { data += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode!, body: data ? JSON.parse(data) : {} }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('同一工作区并发删除与重试共用执行，完成后的重复重试幂等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delete-concurrent-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const workspace = runtime.workspaces.createManaged('Delete')
    runtime.workspaces.createManaged('Keep')
    const session = runtime.sessions.create({ title: 'owned', workspaceId: workspace.id })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let stopping = false, stops = 0
    const originalStop = runtime.coordinator.stopAndWait.bind(runtime.coordinator)
    runtime.coordinator.stopAndWait = async (...args) => { stops++; stopping = true; await gate; return originalStop(...args) }
    const operationId = 'concurrent-delete'
    const first = runtime.deleteWorkspace(workspace.id, { operationId })
    while (!stopping) await Bun.sleep(1)
    const second = runtime.retryWorkspaceDelete(operationId)
    const conflicting = runtime.deleteWorkspace(workspace.id, { operationId: 'different-operation' }).then(() => '', error => String(error))
    expect(await conflicting).toContain('正在执行')
    release()
    await Promise.all([first, second])
    expect(stops).toBe(1)
    expect(runtime.deletions.snapshot().filter(record => record.sessions.some(meta => meta.id === session.id))).toHaveLength(1)
    expect(runtime.listWorkspaceDeleteOperations()).toHaveLength(1)
    await runtime.retryWorkspaceDelete(operationId)
    expect(stops).toBe(1)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('重启重试拒绝已迁出快照的会话和Automation，调度锁不重放手动trigger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delete-ownership-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'offline', name: 'offline', provider: 'anthropic' as const, apiKey: 'fixture-only' }] }
  let runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('Delete'), keep = runtime.workspaces.createManaged('Keep')
    const session = runtime.sessions.create({ title: 'moved', workspaceId: workspace.id })
    const task = runtime.automations.create({ name: 'moved', prompt: 'fixture', active: false, workspaceId: workspace.id, channelId: 'offline', scheduleType: 'interval', intervalMinutes: 60 })
    const operations = new CoreWorkspaceOperationStore(join(root, 'core-workspace-operations.json'))
    operations.begin(workspace, [session], [task], [], Date.now(), 'frozen-scope')
    runtime.sessions.updateMeta(session.id, { workspaceId: keep.id })
    runtime.automations.update({ id: task.id, workspaceId: keep.id })
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    await expect(runtime.retryWorkspaceDelete('frozen-scope')).rejects.toThrow('归属')
    expect(runtime.sessions.getMeta(session.id)?.workspaceId).toBe(keep.id)
    expect(runtime.automations.list().find(item => item.id === task.id)?.workspaceId).toBe(keep.id)
    expect(() => runtime.automations.removeWorkspaceSnapshot(workspace.id, [task.id])).toThrow('迁出')
    expect(runtime.deletions.snapshot()).toHaveLength(0)
    expect(runtime.listWorkspaceDeleteOperations()[0]?.status).toBe('failed')
    const lockedTask = runtime.automations.create({ name: 'locked', prompt: 'fixture', active: false, workspaceId: keep.id, channelId: 'offline', scheduleType: 'interval', intervalMinutes: 60 })
    runtime.automations.manager.enqueueAutomationTrigger({ triggerId: 'queued-before-delete', occurrenceId: 'queued-before-delete', automationId: lockedTask.id, kind: 'manual', scheduledAt: 1, status: 'queued', createdAt: 1, updatedAt: 1 })
    runtime.automations.blockWorkspace(keep.id)
    runtime.automations.tick()
    expect(runtime.automations.manager.getAutomationTrigger('queued-before-delete')?.status).toBe('queued')
    expect(() => runtime.automations.runNow(lockedTask.id)).toThrow('正在删除')
    expect(runtime.listRuns()).toHaveLength(0)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('停止等待期间会话迁出原工作区时保留会话并记录失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delete-stop-move-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  let release!: () => void
  try {
    const workspace = runtime.workspaces.createManaged('Delete'), keep = runtime.workspaces.createManaged('Keep')
    const session = runtime.sessions.create({ title: 'move during stop', workspaceId: workspace.id })
    let stopping = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStop = runtime.coordinator.stopAndWait.bind(runtime.coordinator)
    runtime.coordinator.stopAndWait = async (...args) => { stopping = true; await gate; return originalStop(...args) }
    const deleting = runtime.deleteWorkspace(workspace.id, { operationId: 'stop-move' }).then(() => '', error => String(error))
    while (!stopping) await Bun.sleep(1)
    runtime.sessions.updateMeta(session.id, { workspaceId: keep.id })
    release()
    expect(await deleting).toContain('归属变化')
    expect(runtime.sessions.getMeta(session.id)?.workspaceId).toBe(keep.id)
    expect(runtime.deletions.snapshot()[0]?.status).toBe('failed')
    expect(runtime.workspaces.list().some(item => item.id === workspace.id)).toBe(true)
  } finally { release?.(); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('索引提交后崩溃恢复必须有完成删除记录，无证据不补记完成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delete-index-gap-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('Delete')
    runtime.workspaces.createManaged('Keep')
    runtime.sessions.create({ title: 'owned', workspaceId: workspace.id })
    await runtime.deleteWorkspace(workspace.id, { operationId: 'index-gap' })
    await runtime.shutdown()
    const ledgerPath = join(root, 'core-workspace-operations.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    ledger.operations[0].status = 'pending'
    const requestSnapshot = structuredClone(ledger.operations[0].sessionDeletionRequests)
    ledger.operations[0].sessionDeletionRequests = []
    await writeFile(ledgerPath, JSON.stringify(ledger))
    runtime = createCoreAgentRuntime(config)
    await expect(runtime.retryWorkspaceDelete('index-gap')).rejects.toThrow('完成条件')
    expect(runtime.listWorkspaceDeleteOperations()[0]?.status).toBe('failed')
    await runtime.shutdown()
    ledger.operations[0].sessionDeletionRequests = requestSnapshot
    await writeFile(ledgerPath, JSON.stringify(ledger))
    runtime = createCoreAgentRuntime(config)
    await runtime.retryWorkspaceDelete('index-gap')
    expect(runtime.listWorkspaceDeleteOperations()[0]?.status).toBe('completed')
    expect(runtime.workspaces.list().some(item => item.id === workspace.id)).toBe(false)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('managed删除持久化快照、精确清理并为未纳管文件保留可重试事务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-managed-delete-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'offline', name: 'offline', provider: 'anthropic' as const, apiKey: 'fixture-only' }] }
  let runtime = createCoreAgentRuntime(config)
  const workspace = runtime.workspaces.createManaged('Cascade')
  runtime.workspaces.createManaged('Keep')
  const session = runtime.sessions.create({ title: 'owned', runtime: 'pi', workspaceId: workspace.id })
  const automation = runtime.automations.create({ name: 'owned task', prompt: 'fixture', workspaceId: workspace.id, channelId: 'offline', agentRuntime: 'pi',
    active: false, scheduleType: 'interval', intervalMinutes: 60 })
  const unmanagedFile = join(config.workspaceRoot, workspace.slug, 'user.txt')
  await writeFile(unmanagedFile, 'preserve')
  const operationId = 'workspace-delete-fixture'
  try {
    await expect(runtime.deleteWorkspace(workspace.id, { operationId })).rejects.toThrow('未纳管文件')
    expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
    expect(runtime.automations.list().some(item => item.id === automation.id)).toBe(false)
    expect(runtime.workspaces.list().some(item => item.id === workspace.id)).toBe(true)
    const ledgerPath = join(config.configDir, 'core-workspace-operations.json')
    expect(JSON.parse(await readFile(ledgerPath, 'utf8')).operations[0]).toMatchObject({ operationId, status: 'failed', sessionIds: [session.id], automationIds: [automation.id] })
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.workspaces.list().some(item => item.id === workspace.id)).toBe(true)
    await unlink(unmanagedFile)
    await runtime.retryWorkspaceDelete(operationId)
    expect(runtime.workspaces.list().some(item => item.id === workspace.id)).toBe(false)
    expect(await stat(join(config.workspaceRoot, workspace.slug)).then(() => true, () => false)).toBe(false)
    expect(JSON.parse(await readFile(ledgerPath, 'utf8')).operations[0].status).toBe('completed')
  } finally {
    await runtime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

test('Core工作区HTTP更新持久化；project解绑只暂停任务保留文件历史；managed删除按归属级联且不删除用户文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-workspace-lifecycle-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'offline', name: 'offline', provider: 'anthropic' as const, apiKey: 'fixture-only' }] }
  let runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as { port: number }).port
  try {
    const managed = runtime.workspaces.createManaged('Managed')
    const other = runtime.workspaces.createManaged('Other')
    runtime.workspaces.createManaged('Spare')
    const originalOrder = runtime.workspaces.list().map(item => item.id)
    expect((await json(port, '/workspaces/reorder', 'POST', { orderedIds: [managed.id] }, false)).status).toBe(401)
    for (const orderedIds of [[managed.id, managed.id], ['unknown-id'], [null], 'not-an-array']) {
      expect((await json(port, '/workspaces/reorder', 'POST', { orderedIds })).status).toBe(400)
      expect(runtime.workspaces.list().map(item => item.id)).toEqual(originalOrder)
    }
    expect(await json(port, '/workspaces/reorder', 'POST', { orderedIds: [managed.id] }))
      .toMatchObject({ status: 200, body: { workspaces: [expect.objectContaining({ id: managed.id }), expect.objectContaining({ id: expect.any(String) }), expect.objectContaining({ id: other.id })] } })
    expect((await json(port, `/workspaces/projects/${other.id}`, 'DELETE')).status).toBe(400)
    expect(runtime.workspaces.list().some(item => item.id === other.id)).toBe(true)
    const path = `/workspaces/${managed.id}`
    expect((await json(port, path, 'PATCH', { name: 'Denied' }, false)).status).toBe(401)
    expect((await json(port, path, 'DELETE', undefined, false)).status).toBe(401)
    expect((await json(port, path, 'PATCH', { archived: 'true' })).status).toBe(400)
    expect((await json(port, path, 'PATCH', { name: 'Other' })).status).toBe(400)
    const renamed = await json(port, path, 'PATCH', { name: 'Renamed', archived: true, slug: '../ignored', rootPath: '/ignored' })
    expect(renamed).toMatchObject({ status: 200, body: { id: managed.id, name: 'Renamed', archived: true, slug: managed.slug } })
    const archivedAt = renamed.body.archivedAt
    expect((await json(port, path, 'PATCH', { archived: true })).body.archivedAt).toBe(archivedAt)
    expect((await json(port, path, 'PATCH', { archived: false })).body.archived).toBeUndefined()
    const empty = runtime.workspaces.createManaged('Empty')
    expect((await json(port, `/workspaces/${empty.id}`, 'DELETE')).status).toBe(204)
    expect(await stat(join(config.workspaceRoot, empty.slug)).then(() => true, () => false)).toBe(false)
    const session = runtime.sessions.create({ title: 'keep history', runtime: 'pi', workspaceId: managed.id })
    const task = runtime.automations.create({ name: 'keep task', prompt: 'fixture', workspaceId: managed.id, channelId: 'offline', agentRuntime: 'pi',
      active: false, scheduleType: 'interval', intervalMinutes: 60 })
    expect((await json(port, path, 'DELETE')).status).toBe(204)
    expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
    expect(runtime.automations.list().some(item => item.id === task.id)).toBe(false)
    expect(runtime.workspaces.list().some(item => item.id === managed.id)).toBe(false)
    expect(await stat(join(config.workspaceRoot, managed.slug)).then(() => true, () => false)).toBe(false)
    expect(runtime.deletions.snapshot()).toHaveLength(1)
    await writeFile(join(config.workspaceRoot, other.slug, 'user.txt'), 'user data')
    expect((await json(port, `/workspaces/${other.id}`, 'DELETE')).status).toBe(400)
    const userFile = join(config.workspaceRoot, other.slug, 'user.txt')
    expect(await readFile(userFile, 'utf8')).toBe('user data')
    const deletionList = await json(port, '/workspace-deletions', 'GET')
    const failedOperation = (deletionList.body.operations as Array<{ operationId: string; workspaceId: string; status: string }>).find(item => item.workspaceId === other.id)
    expect(failedOperation?.status).toBe('failed')
    await unlink(userFile)
    expect((await json(port, '/workspaces/delete/retry', 'POST', { operationId: failedOperation?.operationId })).status).toBe(204)
    expect(runtime.workspaces.list().some(item => item.id === other.id)).toBe(false)
    const projectRoot = join(root, 'project')
    await mkdir(projectRoot)
    await writeFile(join(projectRoot, 'user.txt'), 'external data')
    const project = runtime.workspaces.bindProject({ rootPath: projectRoot, name: 'Project' }).workspace
    const child = runtime.sessions.create({ title: 'project history', runtime: 'pi', workspaceId: project.id })
    const projectTask = runtime.automations.create({ name: 'pause on unlink', prompt: 'fixture', workspaceId: project.id, channelId: 'offline', agentRuntime: 'pi',
      active: true, scheduleType: 'interval', intervalMinutes: 60 })
    const owner = runtime.coordinator.ownership.claim({ sessionId: child.id, runtime: 'pi' })
    if (!owner.ok) throw new Error('fixture claim failed')
    try {
      expect((await json(port, `/workspaces/projects/${project.id}`, 'DELETE')).status).toBe(400)
      expect(runtime.automations.list().find(item => item.id === projectTask.id)?.active).toBe(true)
    } finally { runtime.coordinator.ownership.release(child.id, owner.owner.token) }
    const deletionsBeforeProjectUnlink = runtime.deletions.snapshot().length
    expect((await json(port, `/workspaces/projects/${project.id}`, 'DELETE')).status).toBe(204)
    expect(runtime.workspaces.list().some(item => item.id === project.id)).toBe(false)
    expect(runtime.automations.list().find(item => item.id === projectTask.id)?.active).toBe(false)
    expect(runtime.sessions.getMeta(child.id)?.id).toBe(child.id)
    expect(runtime.deletions.snapshot()).toHaveLength(deletionsBeforeProjectUnlink)
    await closeCoreServer(server)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.workspaces.list().some(item => item.id === managed.id)).toBe(false)
    expect(runtime.workspaces.list().some(item => item.id === other.id)).toBe(false)
    expect(runtime.workspaces.list().some(item => item.id === project.id)).toBe(false)
    expect(runtime.automations.list().find(item => item.id === projectTask.id)?.active).toBe(false)
  } finally { await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('桌面只读Core工作区删除在清理任何任务或会话前拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-workspace-readonly-'))
  const indexPath = join(root, 'desktop.json')
  const original = JSON.stringify({ version: 4, workspaces: [
    { id: 'target', name: 'Target', slug: 'target', createdAt: 1, updatedAt: 1 },
    { id: 'other', name: 'Other', slug: 'other', createdAt: 1, updatedAt: 1 },
  ] })
  await writeFile(indexPath, original)
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), desktopWorkspaceIndexPath: indexPath, mockAgent: true })
  try {
    const session = runtime.sessions.create({ title: 'keep', workspaceId: 'target' })
    await expect(runtime.deleteWorkspace('target')).rejects.toThrow('只读')
    expect(runtime.deletions.snapshot()).toHaveLength(0)
    expect(runtime.sessions.getMeta(session.id)?.id).toBe(session.id)
    expect(await readFile(indexPath, 'utf8')).toBe(original)
    expect(() => runtime.updateWorkspace('target', { name: 'Denied' })).toThrow('只读')
    expect(() => runtime.workspaces.reorder(['other', 'target'])).toThrow('只读')
    await expect(runtime.deleteWorkspace('target', { projectOnly: true })).rejects.toThrow('只读')
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

for (const asset of ['workspace-files', 'empty-directory', 'symlink', 'dangling-symlink'] as const) {
  test(`managed删除保护${asset}，重启后同事务只在用户移走资产后完成`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-delete-assets-'))
    const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
    let runtime = createCoreAgentRuntime(config)
    try {
      const workspace = runtime.workspaces.createManaged('Protected')
      runtime.workspaces.createManaged('Keep')
      const directory = join(config.workspaceRoot, workspace.slug)
      const external = join(root, 'external.txt')
      await writeFile(external, 'external sentinel')
      const path = join(directory, asset)
      if (asset === 'workspace-files') {
        await mkdir(path)
        await writeFile(join(path, 'report.md'), 'user artifact')
      } else if (asset === 'empty-directory') await mkdir(path)
      else await symlink(asset === 'symlink' ? external : join(root, 'missing'), path)
      const operationId = `protect-${asset}`
      await expect(runtime.deleteWorkspace(workspace.id, { operationId })).rejects.toThrow('未纳管')
      expect(await readFile(external, 'utf8')).toBe('external sentinel')
      if (asset === 'workspace-files') expect(await readFile(join(path, 'report.md'), 'utf8')).toBe('user artifact')
      expect(runtime.listWorkspaceDeleteOperations()[0]?.status).toBe('failed')
      await runtime.shutdown()
      runtime = createCoreAgentRuntime(config)
      await expect(runtime.retryWorkspaceDelete(operationId)).rejects.toThrow('未纳管')
      await rename(path, join(root, 'user-moved-asset'))
      await runtime.retryWorkspaceDelete(operationId)
      expect(runtime.listWorkspaceDeleteOperations()[0]?.status).toBe('completed')
      expect(await stat(directory).then(() => true, () => false)).toBe(false)
      expect(await readFile(external, 'utf8')).toBe('external sentinel')
    } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
}

test('managed根被替换为软链或普通文件时拒绝删除并保留外部内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delete-root-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const workspace = runtime.workspaces.createManaged('Protected')
    runtime.workspaces.createManaged('Keep')
    const directory = join(root, 'workspaces', workspace.slug)
    await rename(directory, join(root, 'original'))
    const external = join(root, 'external')
    await mkdir(external)
    await writeFile(join(external, 'user.txt'), 'preserve')
    await symlink(external, directory)
    await expect(runtime.deleteWorkspace(workspace.id)).rejects.toThrow('不安全')
    expect(await readFile(join(external, 'user.txt'), 'utf8')).toBe('preserve')
    await unlink(directory)
    await writeFile(directory, 'not a directory')
    await expect(runtime.deleteWorkspace(workspace.id)).rejects.toThrow('不安全')
    expect(await readFile(directory, 'utf8')).toBe('not a directory')
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})
