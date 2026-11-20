import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

describe('sync session index store: 索引恢复保护', () => {
  test('只读宿主读取旧Pi字段和备份不迁移、不恢复写盘，禁止显式写入', async () => {
    const { indexPath, piStatePath } = await setup()
    const legacy = JSON.stringify({ version: 1, sessions: [meta('old', piFields)] })
    await writeFile(indexPath, legacy)
    const reader = createSyncSessionIndexStore(() => indexPath, { readOnly: () => true })
    expect(reader.get('old')).toMatchObject(piFields)
    expect(await readFile(indexPath, 'utf8')).toBe(legacy)
    expect(await stat(piStatePath).then(() => true, () => false)).toBe(false)
    expect(() => reader.write({ version: 1, sessions: [] })).toThrow('Core管理')
    await writeFile(`${indexPath}.bak`, legacy)
    await writeFile(indexPath, '{broken')
    expect(createSyncSessionIndexStore(() => indexPath, { readOnly: () => true }).get('old')?.id).toBe('old')
    expect(await readFile(indexPath, 'utf8')).toBe('{broken')
  })

  test('真正空的首次安装仍可创建索引', async () => {
    const { indexPath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)
    expect(store.list(true)).toEqual([])
    store.write({ version: 1, sessions: [meta('new')] })
    expect(store.get('new')?.id).toBe('new')
  })

  test.each(['{invalid', '', JSON.stringify({ version: 1, sessions: 'invalid' }), JSON.stringify({ sessions: [null] })])(
    '主索引无效时恢复有效备份而不是返回空列表: %s', async (invalid) => {
      const { indexPath } = await setup()
      await writeFile(indexPath, invalid, 'utf8')
      const backup = JSON.stringify({ version: 1, sessions: [meta('old')] })
      await writeFile(`${indexPath}.bak`, backup, 'utf8')
      const store = createSyncSessionIndexStore(() => indexPath)
      expect(store.list(true).map(session => session.id)).toEqual(['old'])
      expect(await readFile(`${indexPath}.bak`, 'utf8')).toBe(backup)
      expect((await readJson(indexPath) as AgentSessionsIndex).sessions[0]?.id).toBe('old')
    },
  )

  test('UTF-8 BOM 的旧索引仍可读取', async () => {
    const { indexPath } = await setup()
    await writeFile(indexPath, '\uFEFF' + JSON.stringify({ version: 1, sessions: [meta('old')] }), 'utf8')
    expect(createSyncSessionIndexStore(() => indexPath).get('old')?.id).toBe('old')
  })

  test('重复会话 ID 的主索引不遮住有效备份', async () => {
    const { indexPath } = await setup()
    await writeFile(indexPath, JSON.stringify({ version: 1, sessions: [meta('same'), meta('same')] }))
    await writeFile(`${indexPath}.bak`, JSON.stringify({ version: 1, sessions: [meta('old')] }))
    expect(createSyncSessionIndexStore(() => indexPath).list(true).map(session => session.id)).toEqual(['old'])
  })

  test('只剩 Pi 状态时同样阻止按首次安装覆盖', async () => {
    const { indexPath, piStatePath } = await setup()
    const pi = JSON.stringify({ version: 1, states: { old: piFields } })
    await writeFile(piStatePath, pi)
    expect(() => createSyncSessionIndexStore(() => indexPath).write({ version: 1, sessions: [] })).toThrow('会话索引')
    expect(await readFile(piStatePath, 'utf8')).toBe(pi)
  })

  test('有效 tmp 可以恢复且不会被自身恢复过程截断', async () => {
    const { indexPath } = await setup()
    await writeFile(indexPath, '{invalid', 'utf8')
    await writeFile(`${indexPath}.tmp`, JSON.stringify({ version: 1, sessions: [meta('pending')] }))
    expect(createSyncSessionIndexStore(() => indexPath).get('pending')?.id).toBe('pending')
  })

  test('无法恢复时明确报错，直接写入也不能覆盖原始索引和 Pi 状态', async () => {
    const { indexPath, piStatePath } = await setup()
    await writeFile(indexPath, '{invalid', 'utf8')
    const pi = JSON.stringify({ version: 1, states: { old: piFields } })
    await writeFile(piStatePath, pi, 'utf8')
    const store = createSyncSessionIndexStore(() => indexPath)
    expect(() => store.read()).toThrow('会话索引')
    expect(() => store.write({ version: 1, sessions: [meta('new')] })).toThrow('会话索引')
    expect(await readFile(indexPath, 'utf8')).toBe('{invalid')
    expect(await readFile(piStatePath, 'utf8')).toBe(pi)
  })

  test('索引缺失但消息存在时不能当新安装写入空索引', async () => {
    const { indexPath } = await setup()
    await mkdir(join(root, 'agent-sessions'))
    await writeFile(join(root, 'agent-sessions', 'old.jsonl'), '{"type":"user"}\n')
    const store = createSyncSessionIndexStore(() => indexPath)
    expect(() => store.read()).toThrow('会话索引')
    expect(() => store.write({ version: 1, sessions: [meta('new')] })).toThrow('会话索引')
    expect(await readFile(join(root, 'agent-sessions', 'old.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
  })

  test('缓存后的外部损坏同样阻止写入，后续补回有效索引可以重新读取', async () => {
    const { indexPath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)
    store.write({ version: 1, sessions: [meta('old')] })
    const next = { version: 1, sessions: [meta('new')] }
    await writeFile(indexPath, '{broken-after-cache', 'utf8')
    expect(() => store.write(next)).toThrow('会话索引')
    expect(await readFile(indexPath, 'utf8')).toBe('{broken-after-cache')
    await writeFile(indexPath, JSON.stringify({ version: 1, sessions: [meta('restored')] }))
    expect(store.get('restored')?.id).toBe('restored')
  })

  test('有效索引允许显式清空，拒绝无效写入入参', async () => {
    const { indexPath } = await setup()
    const store = createSyncSessionIndexStore(() => indexPath)
    store.write({ version: 1, sessions: [meta('old')] })
    expect(() => store.write({ version: 1, sessions: [meta('')] })).toThrow('会话索引')
    expect(store.get('old')?.id).toBe('old')
    store.write({ version: 1, sessions: [] })
    expect(store.list(true)).toEqual([])
  })
})

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
