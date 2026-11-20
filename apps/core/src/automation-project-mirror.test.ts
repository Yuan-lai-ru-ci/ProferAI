import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime } from './runtime'
import { CoreAutomationStore } from './automation-store'
import { writeAutomationMirror, type CoreAutomationIndex } from './automation-project-mirror'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profer-core-auto-mirrors-'))
  const config = { host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true,
    channels: [{ id: 'offline', name: 'Offline', provider: 'anthropic' as const, apiKey: 'fixture-only' }] }
  const project = (name: string) => { const path = join(root, name); mkdirSync(path); return path }
  return { root, config, project }
}
const definition = (workspaceId: string) => ({ name: 'Mirror fixture', prompt: 'offline fixture', workspaceId, channelId: 'offline', agentRuntime: 'pi' as const, active: false, scheduleType: 'interval' as const, intervalMinutes: 60 })
const mirror = (root: string) => JSON.parse(readFileSync(join(root, '.profer', 'automations.json'), 'utf8'))

test('Core项目镜像持续写创建更新trigger迁移删除，重启保留回执且解绑后不写原项目', async () => {
  const { root, config, project } = fixture()
  let runtime = createCoreAgentRuntime(config)
  try {
    const rootA = project('a'), rootB = project('b')
    const a = runtime.workspaces.bindProject({ rootPath: rootA }).workspace
    const b = runtime.workspaces.bindProject({ rootPath: rootB }).workspace
    const task = runtime.automations.create(definition(a.id))
    expect(mirror(rootA).automations[0].id).toBe(task.id)
    runtime.automations.update({ id: task.id, name: 'Changed' })
    expect(mirror(rootA).automations[0].name).toBe('Changed')
    runtime.automations.manager.enqueueAutomationTrigger({ triggerId: 'fixture-completed', occurrenceId: 'fixture-completed', automationId: task.id, scheduledAt: 1, status: 'completed', createdAt: 1, updatedAt: 1 })
    runtime.automations.retryProjectMirrors()
    expect(mirror(rootA).triggers[0].triggerId).toBe('fixture-completed')
    runtime.automations.update({ id: task.id, workspaceId: b.id })
    expect(mirror(rootA).automations).toEqual([])
    expect(mirror(rootB).automations[0].id).toBe(task.id)
    expect(mirror(rootB).triggers[0].triggerId).toBe('fixture-completed')
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.automations.projectMirrorStatuses().every(state => !state.pending && !state.error)).toBe(true)
    runtime.automations.delete(task.id)
    expect(mirror(rootB).automations).toEqual([])
    const before = readFileSync(join(rootA, '.profer', 'automations.json'), 'utf8')
    await runtime.deleteWorkspace(a.id, { projectOnly: true })
    runtime.automations.create(definition(b.id))
    expect(readFileSync(join(rootA, '.profer', 'automations.json'), 'utf8')).toBe(before)
  } finally { await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})

test('镜像损坏保留权威提交与持久错误，恢复原副本后跨重启重试保留扩展字段', async () => {
  const { root, config, project } = fixture()
  let runtime = createCoreAgentRuntime(config)
  try {
    const projectRoot = project('repo')
    const workspace = runtime.workspaces.bindProject({ rootPath: projectRoot }).workspace
    const path = join(projectRoot, '.profer', 'automations.json')
    writeFileSync(path, JSON.stringify({ version: 1, automations: [], triggers: [], extension: { keep: true } }))
    const task = runtime.automations.create(definition(workspace.id))
    expect(mirror(projectRoot).extension).toEqual({ keep: true })
    const before = readFileSync(path, 'utf8')
    writeFileSync(path, '{broken')
    runtime.automations.update({ id: task.id, name: 'Committed centrally' })
    expect(runtime.automations.list()[0]?.name).toBe('Committed centrally')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(runtime.automations.projectMirrorStatuses()[0]).toMatchObject({ pending: true, error: expect.any(String) })
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.automations.projectMirrorStatuses()[0]?.pending).toBe(true)
    writeFileSync(path, before)
    runtime.automations.retryProjectMirrors()
    expect(mirror(projectRoot).automations[0].name).toBe('Committed centrally')
    expect(mirror(projectRoot).extension).toEqual({ keep: true })
    expect(runtime.automations.projectMirrorStatuses()[0]).toMatchObject({ pending: false })
    expect(runtime.automations.projectMirrorStatuses()[0]?.error).toBeUndefined()
  } finally { await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})

test('镜像状态/重试HTTP鉴权，符号链接与未来版本不覆盖且权威数据保留', async () => {
  const { root, config, project } = fixture()
  const runtime = createCoreAgentRuntime(config)
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture-only' })
  let linkPath: string | undefined
  await listenCoreServer(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const projectRoot = project('repo')
    const workspace = runtime.workspaces.bindProject({ rootPath: projectRoot }).workspace
    const task = runtime.automations.create(definition(workspace.id))
    const path = join(projectRoot, '.profer', 'automations.json')
    const original = readFileSync(path, 'utf8')
    const future = JSON.stringify({ version: 99, automations: [], triggers: [] })
    writeFileSync(path, future)
    runtime.automations.update({ id: task.id, name: 'Core committed' })
    expect((await fetch(`${base}/automation-project-mirrors`)).status).toBe(401)
    expect((await fetch(`${base}/automation-project-mirrors/retry`, { method: 'POST' })).status).toBe(401)
    const status = await fetch(`${base}/automation-project-mirrors`, { headers: { authorization: 'Bearer fixture-only' } })
    expect(await status.json()).toMatchObject({ mirrors: [{ workspaceId: workspace.id, pending: true, error: expect.any(String) }] })
    expect(readFileSync(path, 'utf8')).toBe(future)
    unlinkSync(path)
    const outside = join(root, 'outside.json'); writeFileSync(outside, original)
    symlinkSync(outside, path, 'file'); linkPath = path
    runtime.automations.retryProjectMirrors()
    expect(runtime.automations.projectMirrorStatuses()[0]?.error).toBeString()
    expect(readFileSync(outside, 'utf8')).toBe(original)
    unlinkSync(linkPath); linkPath = undefined
    writeFileSync(path, original)
    const retry = await fetch(`${base}/automation-project-mirrors/retry`, { method: 'POST', headers: { authorization: 'Bearer fixture-only' } })
    expect(await retry.json()).toMatchObject({ mirrors: [{ workspaceId: workspace.id, pending: false }] })
    expect(mirror(projectRoot).automations[0].name).toBe('Core committed')
  } finally { if (linkPath) unlinkSync(linkPath); await closeCoreServer(server); await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})

test('项目根丢失不重建，旧回执落盘窗口可按完全一致副本恢复，外部未知任务拒绝覆盖', async () => {
  const { root, config, project } = fixture()
  let runtime = createCoreAgentRuntime(config)
  try {
    const projectRoot = project('repo'), unavailable = join(root, 'unavailable')
    const workspace = runtime.workspaces.bindProject({ rootPath: projectRoot }).workspace
    const task = runtime.automations.create(definition(workspace.id))
    const store = new CoreAutomationStore(join(config.configDir, 'core-automations.json'))
    const prior: CoreAutomationIndex = store.read()
    renameSync(projectRoot, unavailable)
    runtime.automations.update({ id: task.id, active: false })
    expect(runtime.automations.projectMirrorStatuses()[0]?.pending).toBe(true)
    renameSync(unavailable, projectRoot)
    runtime.automations.retryProjectMirrors()
    const current = store.read(), state = current.projectMirrors![0]!
    expect(state.pending).toBe(false)
    // 模拟项目写入完成、中央回执落盘前崩溃：旧hash但副本等于当前Core期望。
    const stale = { ...state, pending: true, lastHash: 'a'.repeat(64) }
    expect(writeAutomationMirror(current, stale, workspace).pending).toBe(false)
    const path = join(projectRoot, '.profer', 'automations.json')
    const foreign = JSON.stringify({ version: 1, automations: [{ ...task, id: 'foreign' }], triggers: [] })
    writeFileSync(path, foreign)
    expect(() => writeAutomationMirror(current, { ...state, pending: true }, workspace)).toThrow('外部修改')
    expect(readFileSync(path, 'utf8')).toBe(foreign)
    expect(prior.projectMirrors).toHaveLength(1)
    unlinkSync(path)
  } finally { await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})
