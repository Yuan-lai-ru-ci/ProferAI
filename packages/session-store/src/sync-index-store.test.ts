import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSyncSessionIndexStore } from './sync-index-store'
import type { AgentSessionsIndex } from './contracts'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

async function setup(): Promise<{ indexPath: string; piStatePath: string }> {
  root = await mkdtemp(join(tmpdir(), 'profer-sync-index-'))
  const indexPath = join(root, 'agent-sessions.json')
  return { indexPath, piStatePath: join(root, 'agent-sessions-pi-state.json') }
}

function meta(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: id, createdAt: 1, updatedAt: 1, ...overrides } as AgentSessionsIndex['sessions'][number]
}

const piFields = {
  piEntryBindings: { 'msg-1': 'entry-1' },
  piFileCheckpoints: { 'entry-1': '/checkpoints/s1/entry-1' },
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

describe('sync session index store: Pi 状态拆分', () => {
  test('写入时把 Pi 大字段拆到独立文件，索引只保留轻量字段', async () => {
    const { indexPath, piStatePath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)

    store.write({ version: 1, sessions: [meta('s1', piFields), meta('s2')] })

    const index = await readJson(indexPath) as { sessions: Array<Record<string, unknown>> }
    expect(index.sessions[0]?.piEntryBindings).toBeUndefined()
    expect(index.sessions[0]?.piFileCheckpoints).toBeUndefined()
    expect(index.sessions[0]?.title).toBe('s1')

    const piState = await readJson(piStatePath) as { states: Record<string, Record<string, unknown>> }
    expect(piState.states.s1?.piEntryBindings).toEqual({ 'msg-1': 'entry-1' })
    expect(piState.states.s1?.piFileCheckpoints).toEqual({ 'entry-1': '/checkpoints/s1/entry-1' })
    expect(piState.states.s2).toBeUndefined()
  })

  test('重新打开后读回完整对象，调用方看到的形状不变', async () => {
    const { indexPath } = await setup()
    const first = createSyncSessionIndexStore(() => indexPath)
    first.write({ version: 1, sessions: [meta('s1', piFields)] })

    const second = createSyncSessionIndexStore(() => indexPath)
    const session = second.get('s1')
    expect(session?.piEntryBindings).toEqual({ 'msg-1': 'entry-1' })
    expect(session?.piFileCheckpoints).toEqual({ 'entry-1': '/checkpoints/s1/entry-1' })
  })

  test('旧格式索引在首次读取时迁移到独立文件，并保留完整备份', async () => {
    const { indexPath, piStatePath } = await setup()
    await writeFile(indexPath, JSON.stringify({
      version: 1,
      sessions: [meta('legacy', piFields)],
    }, null, 2), 'utf8')

    const store = createSyncSessionIndexStore(() => indexPath)
    const session = store.get('legacy')
    expect(session?.piFileCheckpoints).toEqual({ 'entry-1': '/checkpoints/s1/entry-1' })

    const index = await readJson(indexPath) as { sessions: Array<Record<string, unknown>> }
    expect(index.sessions[0]?.piFileCheckpoints).toBeUndefined()

    const piState = await readJson(piStatePath) as { states: Record<string, Record<string, unknown>> }
    expect(piState.states.legacy?.piFileCheckpoints).toEqual({ 'entry-1': '/checkpoints/s1/entry-1' })

    // 迁移前的完整索引落到了 .bak，可人工回溯。
    const backup = await readJson(`${indexPath}.bak`) as { sessions: Array<Record<string, unknown>> }
    expect(backup.sessions[0]?.piFileCheckpoints).toEqual({ 'entry-1': '/checkpoints/s1/entry-1' })
  })

  test('未触碰 Pi 字段的更新不重写独立文件', async () => {
    const { indexPath, piStatePath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)
    store.write({ version: 1, sessions: [meta('s1', piFields)] })

    const before = await stat(piStatePath)
    await Bun.sleep(10)

    const index = store.read()
    index.sessions[0] = { ...index.sessions[0]!, title: 'renamed' }
    store.write(index)

    const after = await stat(piStatePath)
    expect(after.mtimeMs).toBe(before.mtimeMs)

    const persisted = await readJson(indexPath) as { sessions: Array<Record<string, unknown>> }
    expect(persisted.sessions[0]?.title).toBe('renamed')
  })

  test('修改 Pi 字段会重写独立文件；单纯删除会话只做惰性压缩', async () => {
    const { indexPath, piStatePath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)
    store.write({ version: 1, sessions: [meta('s1', piFields), meta('s2', piFields)] })

    const index = store.read()
    index.sessions[0] = { ...index.sessions[0]!, piFileCheckpoints: { 'entry-2': '/checkpoints/s1/entry-2' } }
    store.write(index)

    let piState = await readJson(piStatePath) as { states: Record<string, Record<string, unknown>> }
    expect(piState.states.s1?.piFileCheckpoints).toEqual({ 'entry-2': '/checkpoints/s1/entry-2' })

    // 删除会话不立刻重写 17MB 状态文件：孤儿条目对 mergeSessionIndex 无影响，
    // 留到下一次真实 Pi 变更时一起压缩，避免每次删除都同步写一次大文件。
    store.write({ version: 1, sessions: [index.sessions[0]!] })
    piState = await readJson(piStatePath) as { states: Record<string, Record<string, unknown>> }
    expect(piState.states.s2).toBeDefined()

    // 下一次真实变更：写入时顺手压缩掉孤儿条目。
    const compacted = store.read()
    compacted.sessions[0] = { ...compacted.sessions[0]!, piFileCheckpoints: { 'entry-3': '/checkpoints/s1/entry-3' } }
    store.write(compacted)
    piState = await readJson(piStatePath) as { states: Record<string, Record<string, unknown>> }
    expect(piState.states.s2).toBeUndefined()
    expect(piState.states.s1?.piFileCheckpoints).toEqual({ 'entry-3': '/checkpoints/s1/entry-3' })
  })

  test('独立文件缺失时索引仍可读取（降级为空 Pi 状态）', async () => {
    const { indexPath, piStatePath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)
    store.write({ version: 1, sessions: [meta('s1', piFields)] })
    await rm(piStatePath)

    const reopened = createSyncSessionIndexStore(() => indexPath)
    const session = reopened.get('s1')
    expect(session?.title).toBe('s1')
    expect(session?.piFileCheckpoints).toBeUndefined()
  })
})
