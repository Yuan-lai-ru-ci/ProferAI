import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoreAgentRuntime } from './runtime'

// 全部使用隔离临时Core和合成provider，不读取现用渠道或会话。
test('Core维护项目sidecar/index、跨Core恢复和冲突保护，删除后旧副本不复活', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-project-delete-'))
  const project = join(root, 'project')
  await mkdir(project)
  const config = { host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.bindProject({ rootPath: project }).workspace
    const session = runtime.sessions.create({ title: 'portable', runtime: 'pi', workspaceId: workspace.id })
    runtime.sessions.appendMessages(session.id, [{ type: 'user', uuid: 'fixture', session_id: session.id, parent_tool_use_id: null, message: { role: 'user', content: 'fixture only' } }])
    const sidecar = join(project, '.profer', 'sessions', session.id, 'session.json')
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toMatchObject({ id: session.id, title: 'portable' })
    runtime.sessions.updateMeta(session.id, { title: 'updated title' })
    expect(JSON.parse(await readFile(sidecar, 'utf8')).title).toBe('updated title')
    const indexPath = join(project, '.profer', 'sessions', 'index.json')
    const oldIndex = await readFile(indexPath, 'utf8')
    // 第二个隔离Core只读取项目已有资产，第一实例先退出，不并发写同一项目。
    await runtime.shutdown()
    const other = createCoreAgentRuntime({ ...config, configDir: join(root, 'other'), workspaceRoot: join(root, 'other-workspaces') })
    const opened = other.workspaces.bindProject({ rootPath: project }).workspace
    expect(other.sessions.list()).toContainEqual(expect.objectContaining({ id: session.id, workspaceId: opened.id, title: 'updated title' }))
    expect(other.sessions.readMessages(session.id)).toHaveLength(1)
    await other.shutdown()
    runtime = createCoreAgentRuntime(config)
    const rewindDir = join(project, '.profer', 'rewind', session.id)
    await mkdir(rewindDir, { recursive: true })
    await writeFile(join(rewindDir, 'fixture.json'), '{}')
    const result = runtime.deletions.request(session.id)
    expect(result.sessionIds).toEqual([session.id])
    expect(runtime.sessions.list().find(item => item.id === session.id)).toBeUndefined()
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
    expect(await readFile(sidecar, 'utf8').then(() => true, () => false)).toBe(false)
    expect(await readFile(join(rewindDir, 'fixture.json')).then(() => true, () => false)).toBe(false)
    // 手工遗留项目旧索引代表异步失败/旧备份：Core墓碑阻止再次导入。
    await writeFile(indexPath, oldIndex)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.sessions.list().some(item => item.id === session.id)).toBe(false)
    const remaining = JSON.parse(await readFile(indexPath, 'utf8'))
    expect(remaining.sessions.some((item: { id: string }) => item.id === session.id)).toBe(false)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('独立Core拒绝历史桌面删除接管，不创建事务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-import-denied-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const session = runtime.sessions.create({ title: 'untouched', runtime: 'pi' })
    expect(() => runtime.deletions.importLegacyRequest({ sourceRequestId: 'legacy', sessionId: session.id, sessionIds: [session.id] })).toThrow('仅桌面自有')
    expect(runtime.deletions.snapshot()).toEqual([])
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('历史请求导入逐项校验快照且sourceRequestId重复只产生一条事务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-import-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), desktopWorkspaceIndexPath: join(root, 'desktop-workspaces.json'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const first = runtime.sessions.create({ title: 'first', runtime: 'pi' })
    const second = runtime.sessions.create({ title: 'second', runtime: 'pi' })
    const snapshot = { sourceRequestId: 'old-request', sessionId: first.id, sessionIds: [second.id, first.id] }
    expect(runtime.deletions.importLegacyRequest(snapshot)).toEqual(expect.objectContaining({ requestId: expect.any(String), sessionIds: [second.id, first.id] }))
    expect(runtime.deletions.importLegacyRequest(snapshot)).toEqual(expect.objectContaining({ sessionIds: [second.id, first.id] }))
    expect(runtime.deletions.snapshot()).toHaveLength(1)
    const conflicting = await Promise.resolve().then(() => runtime.deletions.importLegacyRequest({ ...snapshot, sessionIds: [first.id] })).then(() => 'accepted', error => String(error))
    expect(conflicting).toContain('参数冲突')
    expect(runtime.deletions.snapshot()).toHaveLength(1)
    const otherSession = runtime.sessions.create({ title: 'other request', runtime: 'pi' })
    const missing = await Promise.resolve().then(() => runtime.deletions.importLegacyRequest({ sourceRequestId: 'missing', sessionId: otherSession.id, sessionIds: [otherSession.id, 'not-in-core'] })).then(() => 'accepted', error => String(error))
    expect(missing).toContain('缺少Core元数据')
    expect(runtime.deletions.snapshot()).toHaveLength(1)
    await runtime.deletions.drain()
    const accepted = runtime.deletions.importLegacyRequest(snapshot)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.deletions.importLegacyRequest(snapshot)).toEqual(accepted)
    expect(runtime.deletions.snapshot()).toHaveLength(1)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core删除级联仅含附属委派，保留独立会话和项目文件；停止不释放owner则不删', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-order-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  const runtime = createCoreAgentRuntime(config)
  try {
    const parent = runtime.sessions.create({ title: 'parent', runtime: 'pi' })
    const child = runtime.sessions.create({ title: 'child', runtime: 'pi' })
    const independent = runtime.sessions.create({ title: 'independent', runtime: 'pi' })
    runtime.sessions.updateMeta(child.id, { parentSessionId: parent.id, sourceDelegationId: 'child-fixture', delegationRelation: 'subtask' })
    runtime.sessions.updateMeta(independent.id, { parentSessionId: parent.id, sourceDelegationId: 'independent-fixture', delegationRelation: 'independent' })
    const requested = runtime.deletions.request(parent.id)
    expect(requested.sessionIds).toEqual([child.id, parent.id])
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(runtime.sessions.getMeta(independent.id)?.id).toBe(independent.id)
    const blocked = runtime.sessions.create({ title: 'locked', runtime: 'pi' })
    const owner = runtime.coordinator.ownership.claim({ sessionId: blocked.id, runtime: 'pi' })
    if (!owner.ok) throw new Error('fixture owner failed')
    runtime.deletions.request(blocked.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot().find(item => item.sessionId === blocked.id)?.status).toBe('failed')
    const failure = runtime.deletions.statusSnapshots().find(item => item.sessionId === blocked.id)!
    expect(failure).toMatchObject({ kind: 'session_deletion', status: 'failed', title: 'locked', error: expect.any(String) })
    expect(failure).not.toHaveProperty('sessions')
    expect(failure).not.toHaveProperty('sdkSessionId')
    expect(runtime.sessions.getMeta(blocked.id)?.id).toBe(blocked.id)
    runtime.coordinator.ownership.release(blocked.id, owner.owner.token)
    runtime.deletions.request(blocked.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot().find(item => item.sessionId === blocked.id)?.status).toBe('completed')
    expect(runtime.deletions.statusSnapshots().find(item => item.sessionId === blocked.id)?.revision).toBeGreaterThan(failure.revision)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('Core重启恢复pending删除，原生资源共享和符号链接均阻止清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-restart-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const session = runtime.sessions.create({ title: 'restart', runtime: 'pi' })
    const native = join(root, 'pi-sessions')
    await mkdir(native)
    await writeFile(join(native, 'owned.jsonl'), JSON.stringify({ type: 'session', id: 'native-shared' }) + '\n')
    runtime.sessions.updateMeta(session.id, { sdkSessionId: 'native-shared' })
    const other = runtime.sessions.create({ title: 'other', runtime: 'pi' })
    runtime.sessions.updateMeta(other.id, { forkSourceSdkSessionId: 'native-shared' })
    runtime.deletions.request(session.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('另一会话') })
    expect(await readFile(join(native, 'owned.jsonl'), 'utf8')).toContain('native-shared')
    runtime.sessions.updateMeta(other.id, { forkSourceSdkSessionId: undefined })
    const record = runtime.deletions.snapshot()[0]!
    await runtime.shutdown()
    // 模拟已落删除意图、停止清理前退出；重启只执行这个已授权删除事务。
    await writeFile(join(root, 'core-session-deletions.json'), JSON.stringify({ version: 1, records: [{ ...record, status: 'pending' }] }))
    runtime = createCoreAgentRuntime(config)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
    expect(runtime.sessions.getMeta(other.id)?.id).toBe(other.id)
    const linked = runtime.sessions.create({ title: 'linked', runtime: 'pi' })
    const outside = join(root, 'external-asset')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'untouched')
    await mkdir(join(root, 'session-workspaces'), { recursive: true })
    await symlink(outside, join(root, 'session-workspaces', linked.id), process.platform === 'win32' ? 'junction' : 'dir')
    runtime.deletions.request(linked.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot().find(item => item.sessionId === linked.id)?.status).toBe('failed')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('untouched')
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('Core项目冲突保留双方，损坏或未来版本索引不以空文件覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-project-conflict-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const first = join(root, 'first'), second = join(root, 'second')
    await mkdir(first); await mkdir(second)
    const a = runtime.workspaces.bindProject({ rootPath: first }).workspace
    const owned = runtime.sessions.create({ title: 'owned', runtime: 'pi', workspaceId: a.id })
    await mkdir(join(second, '.profer', 'sessions'), { recursive: true })
    const conflicting = { ...owned, title: 'do-not-overwrite', updatedAt: Date.now() + 100000 }
    const secondIndex = join(second, '.profer', 'sessions', 'index.json')
    await writeFile(secondIndex, JSON.stringify({ version: 1, sessions: [conflicting] }))
    runtime.workspaces.bindProject({ rootPath: second })
    expect(runtime.sessions.list().find(item => item.id === owned.id)).toMatchObject({ title: 'owned', workspaceId: a.id })
    expect(JSON.parse(await readFile(secondIndex, 'utf8')).sessions).toContainEqual(conflicting)
    runtime.deletions.request(owned.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(JSON.parse(await readFile(secondIndex, 'utf8')).sessions).toContainEqual(conflicting)
    expect(runtime.deletions.excludedIds(a.id).has(owned.id)).toBe(true)
    const secondWorkspace = runtime.workspaces.list().find(item => item.rootPath === second)!
    expect(runtime.deletions.excludedIds(secondWorkspace.id).has(owned.id)).toBe(false)
    const third = join(root, 'third')
    await mkdir(join(third, '.profer', 'sessions'), { recursive: true })
    const future = JSON.stringify({ version: 99, sessions: [] })
    await writeFile(join(third, '.profer', 'sessions', 'index.json'), future)
    runtime.workspaces.bindProject({ rootPath: third })
    expect(() => runtime.sessions.list()).toThrow('版本')
    expect(await readFile(join(third, '.profer', 'sessions', 'index.json'), 'utf8')).toBe(future)
    // 仅fixture恢复受支持版本，以便正常释放隔离runtime资源。
    await writeFile(join(third, '.profer', 'sessions', 'index.json'), JSON.stringify({ version: 1, sessions: [] }))
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('Core恢复只剩消息的旧项目，原生恢复引用保留在项目副本而非跨Core盲用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-project-legacy-'))
  const project = join(root, 'project')
  await mkdir(join(project, '.profer', 'sessions', 'legacy'), { recursive: true })
  await writeFile(join(project, '.profer', 'sessions', 'legacy', 'messages.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture' } }) + '\n')
  const nativeMeta = { id: 'native-meta', title: 'native', createdAt: 1, updatedAt: 1, sdkSessionId: 'native-id', piSessionFile: 'old-machine/path', agentRuntime: 'pi',
    piEntryBindings: { old: 'entry' }, piFileCheckpoints: { old: 'old-machine/checkpoint' } }
  await mkdir(join(project, '.profer', 'sessions', nativeMeta.id))
  const sidecar = join(project, '.profer', 'sessions', nativeMeta.id, 'session.json')
  await writeFile(sidecar, JSON.stringify(nativeMeta))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    runtime.workspaces.bindProject({ rootPath: project })
    expect(runtime.sessions.list().find(item => item.id === 'legacy')).toMatchObject({ title: '恢复的会话', agentRuntimeLocked: true })
    expect(runtime.sessions.readMessages('legacy')).toHaveLength(1)
    expect(runtime.sessions.getMeta(nativeMeta.id)?.sdkSessionId).toBeUndefined()
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toMatchObject({ sdkSessionId: 'native-id', piSessionFile: 'old-machine/path' })
    runtime.sessions.updateMeta(nativeMeta.id, { title: 'renamed' })
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toMatchObject({ title: 'renamed', sdkSessionId: 'native-id' })
    runtime.sessions.updateMeta(nativeMeta.id, { sdkSessionId: 'new-native', piSessionFile: 'current/path' })
    const refreshed = JSON.parse(await readFile(sidecar, 'utf8'))
    expect(refreshed).toMatchObject({ sdkSessionId: 'new-native', piSessionFile: 'current/path' })
    expect(refreshed.piEntryBindings).toBeUndefined()
    expect(refreshed.piFileCheckpoints).toBeUndefined()
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core项目恢复拒绝非法时间与引擎字段，不覆盖原项目证据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-project-invalid-meta-'))
  const project = join(root, 'project')
  const dir = join(project, '.profer', 'sessions', 'bad-meta')
  await mkdir(dir, { recursive: true })
  const malformed = JSON.stringify({ id: 'bad-meta', title: 'invalid', createdAt: 1, updatedAt: 'tomorrow', agentRuntime: 'unknown' })
  await writeFile(join(dir, 'session.json'), malformed)
  await writeFile(join(dir, 'messages.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture' } }) + '\n')
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    runtime.workspaces.bindProject({ rootPath: project })
    expect(runtime.sessions.list().some(item => item.id === 'bad-meta')).toBe(false)
    expect(await readFile(join(dir, 'session.json'), 'utf8')).toBe(malformed)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core清理中途失败后拒绝晚到写入，重启显式重试继续清理而不复活', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-partial-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const session = runtime.sessions.create({ title: 'partial', runtime: 'pi' })
    const message = { type: 'user' as const, uuid: 'late', session_id: session.id, parent_tool_use_id: null, message: { role: 'user' as const, content: 'fixture' } }
    runtime.sessions.appendMessages(session.id, [message])
    const remove = runtime.sessions.remove
    runtime.sessions.remove = () => { throw new Error('fixture index write failed') }
    runtime.deletions.request(session.id)
    await runtime.deletions.drain()
    const failed = runtime.deletions.snapshot()[0]!
    expect(failed).toMatchObject({ status: 'failed', cleanupStarted: true })
    expect(() => runtime.sessions.appendMessages(session.id, [message])).toThrow('拒绝晚到消息')
    expect(() => runtime.sessions.updateMeta(session.id, { title: 'late title' })).toThrow('拒绝晚到元数据')
    expect(await readFile(join(root, 'agent-sessions', `${session.id}.jsonl`)).then(() => true, () => false)).toBe(false)
    runtime.sessions.remove = remove
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('failed')
    expect(runtime.deletions.isWriteBlocked(session.id)).toBe(true)
    expect(() => runtime.sessions.appendMessages(session.id, [message])).toThrow('拒绝晚到消息')
    runtime.deletions.request(session.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core删除活跃委派时终态不重新投影已隐藏的子会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-active-child-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'fixture', name: 'offline', provider: 'anthropic', apiKey: 'unused', enabled: true,
      agentRuntimes: ['pi'], models: [{ id: 'fixture-model', name: 'fixture', enabled: true }] }] })
  try {
    const workspace = runtime.workspaces.createManaged('delegation')
    const parent = runtime.sessions.create({ title: 'parent', runtime: 'pi', workspaceId: workspace.id, channelId: 'fixture', modelId: 'fixture-model', permissionMode: 'bypassPermissions' })
    const context = { sessionId: parent.id, workspaceId: workspace.id, channelId: 'fixture', modelId: 'fixture-model', agentRuntime: 'pi' as const, permissionMode: 'bypassPermissions' as const }
    const created = await runtime.delegations.delegate(context, { task: 'offline fixture' })
    const childId = (created.delegation as { childSessionId: string }).childSessionId
    const resurrecting: unknown[] = []
    const unsubscribe = runtime.subscribe(event => {
      const payload = event.payload as { kind?: string; session?: { id: string }; event?: { type?: string; session?: { id: string } } }
      if (payload.kind === 'session_projection' && payload.session?.id === childId) resurrecting.push(payload)
      if (payload.event?.type === 'delegation_session_updated' && payload.event.session?.id === childId) resurrecting.push(payload)
    })
    runtime.deletions.request(parent.id)
    await runtime.deletions.drain()
    unsubscribe()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(resurrecting).toEqual([])
    expect(runtime.sessions.getMeta(childId)).toBeUndefined()
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}, 20000)

test('Core完成墓碑覆盖全局索引旧备份恢复，状态监听者失败不撤销删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-projection-failure-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const session = runtime.sessions.create({ title: 'deleted', runtime: 'pi' })
    const indexPath = join(root, 'agent-sessions.json')
    const stale = await readFile(indexPath, 'utf8')
    const unsubscribe = runtime.subscribe(event => {
      const payload = event.payload as { kind?: string }
      if (payload.kind === 'session_projection' || payload.kind === 'session_deletion') throw new Error('fixture observer failed')
    })
    expect(runtime.deletions.request(session.id).sessionIds).toEqual([session.id])
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    unsubscribe()
    await runtime.shutdown()
    // 主索引损坏，旧bak可被底层恢复；删除墓碑仍是更高层业务事实。
    await writeFile(indexPath, '{broken')
    await writeFile(`${indexPath}.bak`, stale)
    runtime = createCoreAgentRuntime(config)
    expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
    expect(runtime.sessions.list(true).some(meta => meta.id === session.id)).toBe(false)
    expect(() => runtime.sessions.readMessages(session.id)).toThrow('session not found')
    runtime.sessions.create({ title: 'new unrelated', runtime: 'pi' })
    expect(JSON.parse(await readFile(indexPath, 'utf8')).sessions.some((meta: { id: string }) => meta.id === session.id)).toBe(false)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})

test('Core删除准确匹配本Core原生Pi身份，不删除别的transcript或外部路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-delete-native-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const session = runtime.sessions.create({ title: 'native', runtime: 'pi' })
    const nativeDir = join(root, 'pi-sessions')
    await mkdir(nativeDir)
    const owned = join(nativeDir, 'owned.jsonl'), other = join(nativeDir, 'unrelated.jsonl')
    await writeFile(owned, JSON.stringify({ type: 'session', id: 'owned-native' }) + '\n')
    await writeFile(other, JSON.stringify({ type: 'session', id: 'other-native' }) + '\n')
    runtime.sessions.updateMeta(session.id, { sdkSessionId: 'owned-native', piSessionFile: join(root, '..', 'not-owned.jsonl') })
    runtime.deletions.request(session.id)
    await runtime.deletions.drain()
    expect(runtime.deletions.snapshot()[0]?.status).toBe('completed')
    expect(await readFile(owned).then(() => true, () => false)).toBe(false)
    expect(await readFile(other).then(() => true, () => false)).toBe(true)
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
})
