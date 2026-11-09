import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_JOURNAL_ENTRIES, ShadowJournal } from './journal'
import { WorkspaceTaskQueue } from './queue'
import type { ShadowCaptureReason, ShadowJournalRoot } from './types'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 真实磁盘路径：journal 的行为（fsync/rename/降级）只有在真文件系统上才成立。 */
function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'profer-shadow-journal-'))
  directories.push(directory)
  return join(directory, 'workspaces', 'workspace-1', 'journal.json')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const MANAGED_ROOT: ShadowJournalRoot = {
  rootId: 'workspace-1',
  rootPath: '/tmp/workspace-1',
  kind: 'managed',
  fileCount: 3,
  treeSha: 'tree-root',
  failures: [],
  skippedCount: 1,
  partial: false,
}

describe('ShadowJournal', () => {
  test('begin → complete 字段完整，重开实例后能读回（模拟重启）', () => {
    const path = journalPath()
    const journal = ShadowJournal.open(path, 'workspace-1')

    const began = journal.begin({ captureId: 'capture-1', reason: 'turn-before', startedAt: 1_000 })
    expect(began).toEqual({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      captureId: 'capture-1',
      reason: 'turn-before',
      status: 'pending',
      startedAt: 1_000,
      roots: [],
    })
    expect(journal.hasPending()).toBe(true)

    journal.complete('capture-1', {
      completedAt: 2_000,
      commitId: 'commit-1',
      treeSha: 'tree-workspace',
      roots: [MANAGED_ROOT],
    })

    expect(journal.hasPending()).toBe(false)
    expect(journal.latestCompleted()).toEqual({
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      captureId: 'capture-1',
      reason: 'turn-before',
      status: 'completed',
      startedAt: 1_000,
      completedAt: 2_000,
      commitId: 'commit-1',
      treeSha: 'tree-workspace',
      roots: [MANAGED_ROOT],
    })

    const reopened = ShadowJournal.open(path, 'workspace-1')
    expect(reopened.latestCompleted()).toEqual(journal.latestCompleted())
    expect(reopened.hasPending()).toBe(false)
  })

  test('返回的记录是深拷贝，调用方改不坏内部状态', () => {
    const path = journalPath()
    const journal = ShadowJournal.open(path, 'workspace-1')
    journal.begin({ captureId: 'capture-1', reason: 'initial', startedAt: 1 })
    journal.complete('capture-1', { completedAt: 2, commitId: 'commit-1', treeSha: 'tree-1', roots: [MANAGED_ROOT] })

    const entry = journal.latestCompleted()
    expect(entry).toBeDefined()
    entry?.roots[0]?.failures.push('被外部篡改')
    if (entry?.roots[0]) entry.roots[0].rootPath = '/tmp/篡改'

    expect(journal.latestCompleted()?.roots[0]).toEqual(MANAGED_ROOT)
    expect(journal.list()[0]?.roots[0]).toEqual(MANAGED_ROOT)
  })

  test('fail 记录 error 且不进入 latestCompleted，hasPending 跟随剩余 pending', () => {
    const path = journalPath()
    const journal = ShadowJournal.open(path, 'workspace-1')
    expect(journal.hasPending()).toBe(false)

    journal.begin({ captureId: 'a', reason: 'initial', startedAt: 10 })
    journal.begin({ captureId: 'b', reason: 'turn-after', startedAt: 20 })
    expect(journal.hasPending()).toBe(true)

    journal.fail('a', 'git 进程崩溃', 30)
    const [failed] = journal.list()
    expect(failed).toMatchObject({ captureId: 'a', status: 'failed', completedAt: 30, error: 'git 进程崩溃' })
    expect(journal.latestCompleted()).toBeUndefined()
    // b 仍是 pending，不能被 a 的失败带走。
    expect(journal.hasPending()).toBe(true)

    journal.complete('b', { completedAt: 40, commitId: 'commit-b', treeSha: 'tree-b', roots: [] })
    expect(journal.hasPending()).toBe(false)
    expect(journal.latestCompleted()?.captureId).toBe('b')

    // 不存在的 captureId 静默忽略，不改动任何已终结记录。
    journal.complete('missing', { completedAt: 50, commitId: 'commit-x', treeSha: 'tree-x', roots: [] })
    journal.fail('missing', '无关错误', 50)
    const entries = ShadowJournal.open(path, 'workspace-1').list()
    expect(entries.map((entry) => [entry.captureId, entry.status])).toEqual([
      ['a', 'failed'],
      ['b', 'completed'],
    ])
  })

  test('损坏 JSON 不抛、主文件留证为 .corrupt-*、以空 journal 启动', () => {
    const path = journalPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ 这不是 JSON', 'utf8')

    const journal = ShadowJournal.open(path, 'workspace-1')
    expect(journal.list()).toEqual([])
    expect(journal.hasPending()).toBe(false)
    expect(existsSync(path)).toBe(false)

    const siblings = readdirSync(dirname(path))
    const quarantined = siblings.filter((name) => name.startsWith('journal.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readdirSync(dirname(path))).toContain(quarantined[0] ?? '')

    // 降级之后必须仍可正常写入。
    journal.begin({ captureId: 'after-corrupt', reason: 'startup-reconcile', startedAt: 5 })
    expect(ShadowJournal.open(path, 'workspace-1').list().map((entry) => entry.captureId)).toEqual(['after-corrupt'])
  })

  test('形状不对（schemaVersion / entries / 单条记录）也不算致命', () => {
    const badSchemaPath = journalPath()
    mkdirSync(dirname(badSchemaPath), { recursive: true })
    writeFileSync(badSchemaPath, JSON.stringify({ schemaVersion: 2, entries: [] }), 'utf8')
    expect(ShadowJournal.open(badSchemaPath, 'workspace-1').list()).toEqual([])
    expect(readdirSync(dirname(badSchemaPath)).some((name) => name.startsWith('journal.json.corrupt-'))).toBe(true)

    const badEntriesPath = journalPath()
    mkdirSync(dirname(badEntriesPath), { recursive: true })
    writeFileSync(badEntriesPath, JSON.stringify({ schemaVersion: 1, entries: 'nope' }), 'utf8')
    expect(ShadowJournal.open(badEntriesPath, 'workspace-1').list()).toEqual([])

    // 单条坏记录只丢自己，合法记录继续可读。
    const mixedPath = journalPath()
    mkdirSync(dirname(mixedPath), { recursive: true })
    const valid = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      captureId: 'ok-1',
      reason: 'initial' satisfies ShadowCaptureReason,
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      commitId: 'commit-1',
      treeSha: 'tree-1',
      roots: [MANAGED_ROOT],
    }
    const invalidRoot = { ...valid, captureId: 'bad-1', roots: [{ rootId: 'x', kind: 'unknown' }] }
    writeFileSync(mixedPath, JSON.stringify({ schemaVersion: 1, entries: [valid, invalidRoot] }), 'utf8')
    const mixed = ShadowJournal.open(mixedPath, 'workspace-1')
    expect(mixed.list().map((entry) => entry.captureId)).toEqual(['ok-1'])
    expect(mixed.latestCompleted()?.roots).toEqual([MANAGED_ROOT])
  })

  test('主文件缺失时读取 .tmp 残留', () => {
    const path = journalPath()
    const source = ShadowJournal.open(path, 'workspace-1')
    source.begin({ captureId: 'capture-1', reason: 'initial', startedAt: 1 })
    source.complete('capture-1', { completedAt: 2, commitId: 'commit-1', treeSha: 'tree-1', roots: [] })

    // 模拟「rename 之前被杀」：内容已完整落在 .tmp，但主文件不存在。
    renameSync(path, `${path}.tmp`)
    expect(ShadowJournal.open(path, 'workspace-1').latestCompleted()?.captureId).toBe('capture-1')
  })

  test('超过上限时丢弃最旧 completed，pending 一律保留', () => {
    const path = journalPath()
    const journal = ShadowJournal.open(path, 'workspace-1')

    for (let index = 0; index < MAX_JOURNAL_ENTRIES + 5; index += 1) {
      const captureId = `capture-${index}`
      journal.begin({ captureId, reason: 'turn-after', startedAt: index })
      journal.complete(captureId, { completedAt: index, commitId: `commit-${index}`, treeSha: `tree-${index}`, roots: [] })
    }
    expect(journal.list()).toHaveLength(MAX_JOURNAL_ENTRIES)
    expect(journal.list()[0]?.captureId).toBe('capture-5')

    journal.begin({ captureId: 'pending-new', reason: 'turn-before', startedAt: 9_999 })
    const entries = journal.list()
    expect(entries).toHaveLength(MAX_JOURNAL_ENTRIES)
    // 再超一条时丢的是最旧的 completed（capture-5），不是刚写进去的 pending。
    expect(entries[0]?.captureId).toBe('capture-6')
    expect(entries.at(-1)?.captureId).toBe('pending-new')
    expect(entries.some((entry) => entry.captureId === 'capture-5')).toBe(false)
    expect(journal.hasPending()).toBe(true)

    // 落盘内容与内存一致：裁剪结果必须持久化，否则重启后条数回弹。
    const reopened = ShadowJournal.open(path, 'workspace-1')
    expect(reopened.list().map((entry) => entry.captureId)).toEqual(entries.map((entry) => entry.captureId))
    expect(reopened.hasPending()).toBe(true)
  })

  test('list(limit) 返回最新 limit 条，仍按旧→新排序', () => {
    const path = journalPath()
    const journal = ShadowJournal.open(path, 'workspace-1')
    for (let index = 0; index < 4; index += 1) {
      journal.begin({ captureId: `capture-${index}`, reason: 'initial', startedAt: index })
    }
    expect(journal.list(2).map((entry) => entry.captureId)).toEqual(['capture-2', 'capture-3'])
    expect(journal.list(0)).toEqual([])
    expect(journal.list()).toHaveLength(4)
  })
})

describe('WorkspaceTaskQueue', () => {
  test('同 key 串行、不同 key 并行，pending 计数准确', async () => {
    const queue = new WorkspaceTaskQueue()
    const gate = deferred<void>()
    const started: string[] = []

    const a1 = queue.run('ws-a', async () => {
      started.push('a1')
      await gate.promise
      return 'a1'
    })
    const a2 = queue.run('ws-a', async () => {
      started.push('a2')
      return 'a2'
    })
    const b1 = queue.run('ws-b', async () => {
      started.push('b1')
      return 'b1'
    })

    expect(queue.pending('ws-a')).toBe(2)
    expect(queue.pending('ws-b')).toBe(1)
    expect(queue.pending('ws-unknown')).toBe(0)

    // b1 与 a1 并行：a1 还没等到 gate，b1 就已完成。
    expect(await b1).toBe('b1')
    expect(started).toEqual(['a1', 'b1'])

    gate.resolve()
    expect(await a1).toBe('a1')
    expect(await a2).toBe('a2')
    expect(started).toEqual(['a1', 'b1', 'a2'])

    await queue.drain()
    expect(queue.pending('ws-a')).toBe(0)
    expect(queue.pending('ws-b')).toBe(0)
  })

  test('前一个任务 reject（含同步抛错）不影响后续任务', async () => {
    const queue = new WorkspaceTaskQueue()

    const rejected = queue.run('ws-a', async () => {
      throw new Error('第一个任务失败')
    })
    const resolved = queue.run('ws-a', async () => 'ok')
    const syncThrow = queue.run('ws-a', () => {
      throw new Error('同步抛错')
    })

    await expect(rejected).rejects.toThrow('第一个任务失败')
    await expect(resolved).resolves.toBe('ok')
    await expect(syncThrow).rejects.toThrow('同步抛错')

    // 链上出现失败后，队尾仍可继续接收任务。
    await expect(queue.run('ws-a', async () => 'after-failure')).resolves.toBe('after-failure')
    await queue.drain()
    expect(queue.pending('ws-a')).toBe(0)
  })

  test('sync 抛错的任务也会变成 reject 而不是同步抛出', () => {
    const queue = new WorkspaceTaskQueue()
    let promise: Promise<never> | undefined
    expect(() => {
      promise = queue.run('ws-a', () => {
        throw new Error('同步抛错')
      })
    }).not.toThrow()
    expect(promise).toBeDefined()
    return expect(promise as Promise<never>).rejects.toThrow('同步抛错')
  })

  test('drain 等待全部完成，包括等待期间新加入的任务', async () => {
    const queue = new WorkspaceTaskQueue()
    const finished: string[] = []
    const gate = deferred<void>()

    queue.run('ws-a', async () => {
      await gate.promise
      finished.push('a1')
    })
    queue.run('ws-b', async () => {
      finished.push('b1')
    })

    const draining = queue.drain()
    // drain 已经在等之后才入队的任务，也必须被等到。
    queue.run('ws-c', async () => {
      finished.push('c1')
    })
    queue.run('ws-a', async () => {
      finished.push('a2')
    })

    gate.resolve()
    await draining

    expect(finished.sort()).toEqual(['a1', 'a2', 'b1', 'c1'])
    expect(queue.pending('ws-a')).toBe(0)
    expect(queue.pending('ws-b')).toBe(0)
    expect(queue.pending('ws-c')).toBe(0)
    // drain 之后队列仍是可用状态。
    await expect(queue.run('ws-a', async () => 'reuse')).resolves.toBe('reuse')
  })

  test('drain 在空队列上立即 resolve，且不会 reject', async () => {
    const queue = new WorkspaceTaskQueue()
    await expect(queue.drain()).resolves.toBeUndefined()

    queue.run('ws-a', async () => {
      throw new Error('失败任务')
    })
    await expect(queue.drain()).resolves.toBeUndefined()
  })

  test('空 key 属于开发期误用，直接抛错', () => {
    const queue = new WorkspaceTaskQueue()
    expect(() => queue.run('', async () => undefined)).toThrow('key 不能为空字符串')
    expect(queue.pending('')).toBe(0)
  })
})
