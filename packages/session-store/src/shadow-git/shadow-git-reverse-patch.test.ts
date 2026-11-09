/**
 * 逆向 patch 的场景测试（Phase 3）。
 *
 * 覆盖设计 §10 里「局部回退」那一组 Given/When/Then，全部用真实 git 仓库 +
 * 真实文件系统，不做 mock：三方合并的正确性只可能在真实文本上体现。
 *
 * 每个场景都从「采集一次 before → 按 mutate 改文件 → 采集一次 after」开始，
 * 与真实 turn 边界产出的记录同构；需要「用户之后又改了」的场景在 setup 之后自己写。
 */

import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  buildShadowTurnAttribution,
  diffShadowCommits,
  type ShadowTurnAttributionRecord,
  type ShadowTurnEvidenceItem,
} from './attribution'
import { createGitRunner, type GitRunner } from './git-command'
import { WorkspaceShadowRepository } from './repository'
import { restoreShadowTurnChanges } from './reverse-patch'
import type { ShadowRoot } from './types'

const WORKSPACE_ID = 'workspace-reverse-patch'
const SESSION_ID = 'session-reverse-patch'

const GIT_PATH = (() => {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, executable))
    .find((candidate) => existsSync(candidate))
  if (fromPath) return fromPath
  return ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'].find((candidate) => existsSync(candidate)) ?? null
})()

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

interface Fixture {
  baseDir: string
  rootPath: string
  repoDir: string
  runner: ReturnType<typeof createGitRunner>
  roots: ShadowRoot[]
  beforeCommitId: string
  afterCommitId: string
}

function writeFiles(rootPath: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(rootPath, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
}

async function setupTurn(options: {
  files: Record<string, string | Buffer>
  /** 采集 before 之前的准备（例如给文件加可执行位）；在写文件之后、采集之前执行。 */
  prepare?: (rootPath: string) => void
  /** Agent 这一轮做的改动；拿到的是根路径。 */
  mutate: (rootPath: string) => void
}): Promise<Fixture> {
  const baseDir = mkdtempSync(join(tmpdir(), 'profer-reverse-patch-'))
  tempDirs.push(baseDir)
  const rootPath = join(baseDir, 'root')
  mkdirSync(rootPath, { recursive: true })
  writeFiles(rootPath, options.files)
  options.prepare?.(rootPath)
  const repoDir = join(baseDir, 'shadow', 'repo.git')
  const repository = await WorkspaceShadowRepository.open({
    workspaceId: WORKSPACE_ID,
    repoDir,
    journalPath: join(baseDir, 'shadow', 'journal.json'),
    gitPath: GIT_PATH!,
    tempDir: join(baseDir, 'shadow', 'tmp'),
  })
  const roots: ShadowRoot[] = [{ rootId: WORKSPACE_ID, rootPath, kind: 'project' }]
  const before = await repository.capture({ reason: 'turn-before', roots })
  options.mutate(rootPath)
  const after = await repository.capture({ reason: 'turn-after', roots })
  return {
    baseDir,
    rootPath,
    repoDir,
    runner: createGitRunner({ gitPath: GIT_PATH! }),
    roots,
    beforeCommitId: before.commitId,
    afterCommitId: after.commitId,
  }
}

/** 用真实 before/after 提交算 diff，再按证据生成记录（与生产路径同构）。 */
async function attributionFor(
  fixture: Fixture,
  evidence: Array<{ path: string; source?: ShadowTurnEvidenceItem['source'] }>,
): Promise<ShadowTurnAttributionRecord> {
  const diff = await diffShadowCommits(fixture.runner, fixture.repoDir, fixture.beforeCommitId, fixture.afterCommitId)
  if (!diff.ok) throw new Error(diff.error)
  return buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-1',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    beforeCommitId: fixture.beforeCommitId,
    afterCommitId: fixture.afterCommitId,
    diff: diff.entries,
    evidence: evidence.map((item, index) => ({ seq: index + 1, path: item.path, source: item.source ?? 'write' })),
    roots: [{ rootId: WORKSPACE_ID, rootPath: fixture.rootPath, kind: 'project' }],
    partial: false,
  })
}

async function restore(fixture: Fixture, record: ShadowTurnAttributionRecord, dryRun = false) {
  return restoreShadowTurnChanges({
    runner: fixture.runner,
    repoDir: fixture.repoDir,
    tempDir: join(fixture.baseDir, 'restore-tmp'),
    record,
    rootPaths: new Map([[WORKSPACE_ID, fixture.rootPath]]),
    dryRun,
  })
}

test.skipIf(!GIT_PATH)(
  '用户没再改过：Agent 修改的文件恢复到改动前',
  async () => {
    const fixture = await setupTurn({
      files: { 'app.ts': 'line1\nline2\nline3\n' },
      mutate: (root) => writeFileSync(join(root, 'app.ts'), 'line1\nAGENT\nline3\n', 'utf8'),
    })
    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'app.ts') }])
    expect(record.changes.map((change) => change.status)).toEqual(['modified'])

    const result = await restore(fixture, record)
    expect(result.counts).toMatchObject({ restored: 1, kept: 0, skipped: 0 })
    expect(readFileSync(join(fixture.rootPath, 'app.ts'), 'utf8')).toBe('line1\nline2\nline3\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'Agent 新建、用户没动过：文件被删除',
  async () => {
    const fixture = await setupTurn({
      files: { 'keep.md': 'keep\n' },
      mutate: (root) => writeFileSync(join(root, 'new.md'), '# new\n', 'utf8'),
    })
    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'new.md') }])
    expect(record.changes.map((change) => [change.path, change.status])).toEqual([['new.md', 'added']])

    const result = await restore(fixture, record)
    expect(result.counts).toMatchObject({ deleted: 1 })
    expect(existsSync(join(fixture.rootPath, 'new.md'))).toBe(false)
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'Agent 新建后用户继续修改：保留用户当前内容（不能整文件删除）',
  async () => {
    const fixture = await setupTurn({
      files: { 'keep.md': 'keep\n' },
      mutate: (root) => writeFileSync(join(root, 'new.md'), '# agent\n', 'utf8'),
    })
    writeFileSync(join(fixture.rootPath, 'new.md'), '# agent\n用户补了一段\n', 'utf8')

    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'new.md') }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'edited-after-turn' })
    expect(readFileSync(join(fixture.rootPath, 'new.md'), 'utf8')).toBe('# agent\n用户补了一段\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'Agent 删除、用户没重建：恢复原内容',
  async () => {
    const fixture = await setupTurn({
      files: { 'gone.md': '# gone\n' },
      mutate: (root) => unlinkSync(join(root, 'gone.md')),
    })
    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'gone.md') }])
    expect(record.changes.map((change) => change.status)).toEqual(['deleted'])

    const result = await restore(fixture, record)
    expect(result.counts).toMatchObject({ restored: 1 })
    expect(readFileSync(join(fixture.rootPath, 'gone.md'), 'utf8')).toBe('# gone\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'Agent 删除后用户用不同内容重建：不覆盖用户内容',
  async () => {
    const fixture = await setupTurn({
      files: { 'gone.md': '# gone\n' },
      mutate: (root) => unlinkSync(join(root, 'gone.md')),
    })
    writeFileSync(join(fixture.rootPath, 'gone.md'), '# 用户重写\n', 'utf8')

    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'gone.md') }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'recreated-after-turn' })
    expect(readFileSync(join(fixture.rootPath, 'gone.md'), 'utf8')).toBe('# 用户重写\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '非重合区域：撤销 Agent 的改动，保留用户改的另一处（三方合并）',
  async () => {
    const original = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n'
    const agentEdit = ['1', 'AGENT', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n'
    const fixture = await setupTurn({
      files: { 'doc.md': original },
      mutate: (root) => writeFileSync(join(root, 'doc.md'), agentEdit, 'utf8'),
    })
    // 用户在本轮之后改了第 9 行（离 Agent 改的第 2 行很远）。
    const userEdit = ['1', 'AGENT', '3', '4', '5', '6', '7', '8', 'USER', '10'].join('\n') + '\n'
    writeFileSync(join(fixture.rootPath, 'doc.md'), userEdit, 'utf8')

    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'doc.md') }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'restore', reason: 'clean-merge' })
    // 第 2 行回到 Agent 改动前，第 9 行保留用户的内容。
    expect(readFileSync(join(fixture.rootPath, 'doc.md'), 'utf8')).toBe(
      ['1', '2', '3', '4', '5', '6', '7', '8', 'USER', '10'].join('\n') + '\n',
    )
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '同一区域冲突：保留当前内容，不写入冲突标记',
  async () => {
    const original = ['1', '2', '3', '4', '5'].join('\n') + '\n'
    const agentEdit = ['1', '2', 'AGENT', '4', '5'].join('\n') + '\n'
    const fixture = await setupTurn({
      files: { 'doc.md': original },
      mutate: (root) => writeFileSync(join(root, 'doc.md'), agentEdit, 'utf8'),
    })
    const userEdit = ['1', '2', 'USER', '4', '5'].join('\n') + '\n'
    writeFileSync(join(fixture.rootPath, 'doc.md'), userEdit, 'utf8')

    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'doc.md') }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'conflict-kept-current' })
    const finalText = readFileSync(join(fixture.rootPath, 'doc.md'), 'utf8')
    expect(finalText).toBe(userEdit)
    expect(finalText).not.toContain('<<<<<<<')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '没有受控写入证据的变化：一律不撤销（Bash/外部进程/用户手改）',
  async () => {
    const fixture = await setupTurn({
      files: { 'a.md': 'a\n' },
      mutate: (root) => writeFileSync(join(root, 'a.md'), 'a\nagent\n', 'utf8'),
    })
    const record = await attributionFor(fixture, [])
    expect(record.changes[0]?.attribution).toBe('unconfirmed')

    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'skip', reason: 'unconfirmed-change' })
    expect(readFileSync(join(fixture.rootPath, 'a.md'), 'utf8')).toBe('a\nagent\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'dryRun 只算计划不写盘',
  async () => {
    const fixture = await setupTurn({
      files: { 'a.md': 'a\n' },
      mutate: (root) => writeFileSync(join(root, 'a.md'), 'a\nagent\n', 'utf8'),
    })
    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'a.md') }])

    const result = await restore(fixture, record, true)
    expect(result.counts).toMatchObject({ restored: 1 })
    // 计划说会恢复，但磁盘上仍是 Agent 的版本。
    expect(readFileSync(join(fixture.rootPath, 'a.md'), 'utf8')).toBe('a\nagent\n')
  },
  30_000,
)

// ---- 独立审查发现的回归（每条都对应一个真实失败模式） ----

test.skipIf(!GIT_PATH)(
  '读不到当前文件（权限不足）时绝不覆盖：按 keep-current 处理',
  async () => {
    const fixture = await setupTurn({
      files: { 'secret.md': '# secret\n' },
      mutate: (root) => unlinkSync(join(root, 'secret.md')),
    })
    // 用户重建并用 0600→0000 锁住：读失败不能被当成「文件不存在」。
    const target = join(fixture.rootPath, 'secret.md')
    writeFileSync(target, '# 用户重建\n', 'utf8')
    chmodSync(target, 0o000)

    const record = await attributionFor(fixture, [{ path: target }])
    const result = await restore(fixture, record)
    chmodSync(target, 0o644)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'current-unreadable' })
    expect(readFileSync(target, 'utf8')).toBe('# 用户重建\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '边界对象读不到时整条跳过：不能把「读不到」当成「没有这个文件」',
  async () => {
    const fixture = await setupTurn({
      files: { 'a.md': 'a\n' },
      mutate: (root) => writeFileSync(join(root, 'a.md'), 'a\nagent\n', 'utf8'),
    })
    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'a.md') }])
    // 模拟对象被 gc / 记录损坏：before 指向一个不存在的提交。
    const broken = { ...record, beforeCommitId: 'deadbeef'.repeat(5) }

    const result = await restore(fixture, broken)
    expect(result.entries[0]).toMatchObject({ action: 'skip', reason: 'boundary-unreadable' })
    expect(readFileSync(join(fixture.rootPath, 'a.md'), 'utf8')).toBe('a\nagent\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '非 UTF-8 文本（GBK）走合并后字节不变：不能被 UTF-8 解码成 U+FFFD',
  async () => {
    const gbkLine = (digit: number) => Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x20, 0x30 + digit, 0x0a])
    const original = Buffer.concat([gbkLine(1), gbkLine(2), gbkLine(3), gbkLine(4), gbkLine(5)])
    const agentEdit = Buffer.concat([gbkLine(1), Buffer.from('AGENT\n'), gbkLine(3), gbkLine(4), gbkLine(5)])
    const fixture = await setupTurn({
      files: { 'data.txt': original },
      mutate: (root) => writeFileSync(join(root, 'data.txt'), agentEdit),
    })
    // 用户改第 5 行（离 Agent 改的第 2 行很远）。
    const userEdit = Buffer.concat([gbkLine(1), Buffer.from('AGENT\n'), gbkLine(3), gbkLine(4), Buffer.from('USER\n')])
    writeFileSync(join(fixture.rootPath, 'data.txt'), userEdit)

    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'data.txt') }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'restore', reason: 'clean-merge' })
    const bytes = readFileSync(join(fixture.rootPath, 'data.txt'))
    // 关键：没有 U+FFFD（EF BF BD），第 2 行回到原始 GBK，第 5 行保留用户内容。
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
    expect(bytes.equals(Buffer.concat([gbkLine(1), gbkLine(2), gbkLine(3), gbkLine(4), Buffer.from('USER\n')]))).toBe(true)
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '记录 partial 时只恢复不删除：added 的变化整条跳过',
  async () => {
    const fixture = await setupTurn({
      files: { 'keep.md': 'keep\n' },
      mutate: (root) => writeFileSync(join(root, 'agent.md'), '# agent\n', 'utf8'),
    })
    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'agent.md') }])
    const result = await restore(fixture, { ...record, partial: true })
    expect(result.entries[0]).toMatchObject({ action: 'skip', reason: 'partial-evidence' })
    expect(existsSync(join(fixture.rootPath, 'agent.md'))).toBe(true)
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '修改场景：回退保留用户当前的 0755 权限（不依赖快照里的 mode）',
  async () => {
    const fixture = await setupTurn({
      files: { 'script.sh': '#!/bin/sh\necho 1\n' },
      mutate: (root) => writeFileSync(join(root, 'script.sh'), '#!/bin/sh\necho 2\n', 'utf8'),
    })
    const target = join(fixture.rootPath, 'script.sh')
    chmodSync(target, 0o755)
    // 重新采集一次，让 after 记录 0755 与内容 echo 2
    const after = await (await import('./repository')).WorkspaceShadowRepository.open({
      workspaceId: WORKSPACE_ID,
      repoDir: fixture.repoDir,
      journalPath: join(fixture.baseDir, 'shadow', 'journal.json'),
      gitPath: GIT_PATH!,
      tempDir: join(fixture.baseDir, 'shadow', 'tmp'),
    }).then((repo) => repo.capture({ reason: 'turn-after', roots: fixture.roots }))
    const record = await attributionFor({ ...fixture, afterCommitId: after.commitId }, [{ path: target }])

    const result = await restore({ ...fixture, afterCommitId: after.commitId }, record)
    expect(result.entries[0]?.action).toBe('restore')
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho 1\n')
    expect(statSync(target).mode & 0o777).toBe(0o755)
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '当前路径变成目录：keep-current，不抛错也不删除',
  async () => {
    const fixture = await setupTurn({
      files: { 'keep.md': 'keep\n' },
      mutate: (root) => writeFileSync(join(root, 'thing.md'), 'x\n', 'utf8'),
    })
    const target = join(fixture.rootPath, 'thing.md')
    unlinkSync(target)
    mkdirSync(join(target, 'nested'), { recursive: true })

    const record = await attributionFor(fixture, [{ path: target }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'current-unreadable' })
    expect(existsSync(join(target, 'nested'))).toBe(true)
  },
  30_000,
)

async function fixtureAfterRecapture(fixture: Fixture): Promise<string> {
  const repository = await WorkspaceShadowRepository.open({
    workspaceId: WORKSPACE_ID,
    repoDir: fixture.repoDir,
    journalPath: join(fixture.baseDir, 'shadow', 'journal.json'),
    gitPath: GIT_PATH!,
    tempDir: join(fixture.baseDir, 'shadow', 'tmp'),
  })
  const captured = await repository.capture({ reason: 'turn-after', roots: fixture.roots })
  return captured.commitId
}

test.skipIf(!GIT_PATH)(
  '用户在两轮之间新建的文件，Agent 本轮改过：不按「Agent 新建」删除',
  async () => {
    const fixture = await setupTurn({
      files: {},
      mutate: (root) => writeFileSync(join(root, 'user-made.md'), 'USER 1\nUSER 2\n', 'utf8'),
    })
    const target = join(fixture.rootPath, 'user-made.md')
    const record = await attributionFor(fixture, [{ path: target }])
    // 真实数据里这一条会被打成 added（上一轮 turn-after 里没有这个文件）；
    // 但证据带出了 before 内容引用，说明写入前它就已经在磁盘上。
    const patched = {
      ...record,
      changes: record.changes.map((change) => ({ ...change, status: 'added' as const, preexisting: true })),
    }
    const result = await restore(fixture, patched)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'preexisting-file' })
    expect(existsSync(target)).toBe(true)
  },
  30_000,
)

// ---- 修复：可执行位、写前复核、partial 删除守卫、merge-file 退出码 ----

test.skipIf(!GIT_PATH)(
  '删除场景：Agent 删掉 0755 脚本，回退后恢复内容并且仍是 0755',
  async () => {
    const fixture = await setupTurn({
      files: { 'deploy.sh': '#!/bin/sh\necho 1\n' },
      // before 快照里这个文件就是可执行的：恢复必须按 tree 里的 100755 还原。
      prepare: (root) => chmodSync(join(root, 'deploy.sh'), 0o755),
      mutate: (root) => unlinkSync(join(root, 'deploy.sh')),
    })
    const target = join(fixture.rootPath, 'deploy.sh')
    const record = await attributionFor(fixture, [{ path: target }])
    expect(record.changes.map((change) => change.status)).toEqual(['deleted'])

    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'restore', reason: 'restored-verbatim' })
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho 1\n')
    expect(statSync(target).mode & 0o777).toBe(0o755)
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'deleted 分支：判定后用户新建同名文件，写盘前复核不覆盖',
  async () => {
    const fixture = await setupTurn({
      files: { 'notes.md': 'agent era\n' },
      mutate: (root) => unlinkSync(join(root, 'notes.md')),
    })
    const target = join(fixture.rootPath, 'notes.md')
    const record = await attributionFor(fixture, [{ path: target }])

    // deleted 分支唯一的 await 点就是 cat-file blob：在这个窗口里插入「用户刚保存」的动作。
    const realRunner = fixture.runner
    let injected = false
    const racingRunner: GitRunner = {
      gitPath: realRunner.gitPath,
      async run(args, options) {
        const result = await realRunner.run(args, options)
        if (!injected && args[0] === 'cat-file' && args[1] === 'blob') {
          injected = true
          writeFileSync(target, '用户刚保存的新版本\n', 'utf8')
        }
        return result
      },
    }

    const result = await restoreShadowTurnChanges({
      runner: racingRunner,
      repoDir: fixture.repoDir,
      tempDir: join(fixture.baseDir, 'restore-tmp'),
      record,
      rootPaths: new Map([[WORKSPACE_ID, fixture.rootPath]]),
    })
    expect(injected).toBe(true)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'concurrent-modification' })
    expect(readFileSync(target, 'utf8')).toBe('用户刚保存的新版本\n')
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  'partial 记录下 modified 且 before 在树中缺失：跳过而不删除',
  async () => {
    const fixture = await setupTurn({
      files: { 'keep.md': 'keep\n' },
      // agent.md 只存在于 after：before 里没有它，modified 的撤销动作会退化成 unlink。
      mutate: (root) => writeFileSync(join(root, 'agent.md'), '# agent\n', 'utf8'),
    })
    const target = join(fixture.rootPath, 'agent.md')
    const record = await attributionFor(fixture, [{ path: target }])
    const patched: ShadowTurnAttributionRecord = {
      ...record,
      partial: true,
      changes: record.changes.map((change) => ({ ...change, status: 'modified' as const })),
    }

    const result = await restore(fixture, patched)
    expect(result.entries[0]).toMatchObject({ action: 'skip', reason: 'partial-evidence' })
    expect(existsSync(target)).toBe(true)
  },
  30_000,
)

test.skipIf(!GIT_PATH)(
  '多处冲突（merge-file 退出码 2）：仍判为冲突并保留当前内容',
  async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`)
    const original = `${lines.join('\n')}\n`
    const agentLines = [...lines]
    agentLines[4] = 'AGENT-5'
    agentLines[44] = 'AGENT-45'
    const agentEdit = `${agentLines.join('\n')}\n`
    const fixture = await setupTurn({
      files: { 'doc.md': original },
      mutate: (root) => writeFileSync(join(root, 'doc.md'), agentEdit, 'utf8'),
    })
    // 用户在两处（相隔 40 行）都改成了自己的内容：git merge-file 会返回 2 而不是 1。
    const userLines = [...agentLines]
    userLines[4] = 'USER-5'
    userLines[44] = 'USER-45'
    const userEdit = `${userLines.join('\n')}\n`
    writeFileSync(join(fixture.rootPath, 'doc.md'), userEdit, 'utf8')

    const record = await attributionFor(fixture, [{ path: join(fixture.rootPath, 'doc.md') }])
    const result = await restore(fixture, record)
    expect(result.entries[0]).toMatchObject({ action: 'keep-current', reason: 'conflict-kept-current' })
    const finalText = readFileSync(join(fixture.rootPath, 'doc.md'), 'utf8')
    expect(finalText).toBe(userEdit)
    expect(finalText).not.toContain('<<<<<<<')
  },
  30_000,
)
