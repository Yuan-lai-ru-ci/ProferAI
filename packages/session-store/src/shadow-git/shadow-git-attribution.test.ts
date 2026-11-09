/**
 * turn 变更归属的测试（Phase 2）。
 *
 * 分两层：
 * 1. 纯函数层：diff 输出解析、证据与树差异的交叉判定（不需要真实 git）；
 * 2. 真实仓库层：两次采集之间改/增/删文件，验证 diff 出来的状态与证据命中。
 *
 * 重点覆盖「不能把没证据的变化说成 Agent 改的」这条：Bash/外部进程留下的差异
 * 必须是 unconfirmed，否则 Phase 3 的回退会去撤销用户自己的编辑。
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  appendShadowForkRelation,
  appendShadowTurnAttribution,
  buildShadowTurnAttribution,
  compactShadowAttributions,
  diffShadowCommits,
  findShadowTurnAttribution,
  maybeCompactShadowAttributions,
  parseShadowDiffTreeOutput,
  readShadowForkRelation,
  readShadowTurnAttributions,
  shadowTurnChangeTreePath,
} from './attribution'
import type { ShadowTurnAttributionRecord, ShadowTurnEvidenceItem } from './attribution'
import { createGitRunner } from './git-command'
import { WorkspaceShadowRepository } from './repository'
import type { ShadowRoot } from './types'

const WORKSPACE_ID = 'workspace-attribution'
const SESSION_ID = 'session-attribution'

function root(rootId: string, rootPath: string): { rootId: string; rootPath: string; kind: 'project' } {
  return { rootId, rootPath, kind: 'project' }
}

function entry(mode: string, status: string, path: string): string {
  return `:${mode} ${mode} ${'a'.repeat(40)} ${'b'.repeat(40)} ${status}\0${path}\0`
}

test('diff 输出解析：A/M/D 三种状态、NUL 分隔、非法路径与未知状态被跳过', () => {
  const stdout = [
    entry('100644', 'A', 'roots/root-1/src/new.ts'),
    entry('100644', 'M', 'roots/root-1/src/app.ts'),
    entry('100644', 'D', 'roots/root-1/old.txt'),
    entry('100644', 'T', 'roots/root-1/link'),
    entry('100644', 'R100', 'roots/root-1/renamed.ts'),
    entry('100644', 'M', 'not-a-shadow-path.txt'),
    entry('100644', 'M', 'roots/root-1'),
  ].join('')

  const parsed = parseShadowDiffTreeOutput(stdout)
  expect(parsed).toEqual([
    { rootId: 'root-1', path: 'src/new.ts', status: 'added' },
    { rootId: 'root-1', path: 'src/app.ts', status: 'modified' },
    { rootId: 'root-1', path: 'old.txt', status: 'deleted' },
    { rootId: 'root-1', path: 'link', status: 'modified' },
  ])
})

test('文件名带空格/中文/换行时不依赖转义', () => {
  const parsed = parseShadowDiffTreeOutput(entry('100644', 'M', 'roots/root-1/带 空格 的 文件.md'))
  expect(parsed).toEqual([{ rootId: 'root-1', path: '带 空格 的 文件.md', status: 'modified' }])
})

test('归属判定：证据命中为 confirmed，只有树差异为 unconfirmed', () => {
  const rootPath = '/tmp/workspace-root'
  const evidence: ShadowTurnEvidenceItem[] = [
    { seq: 1, toolUseId: 't1', toolName: 'Write', path: '/tmp/workspace-root/src/agent.ts', source: 'write' },
    { seq: 2, toolUseId: 't2', toolName: 'Bash', path: '/tmp/workspace-root/src/bash-made.ts', source: 'bash' },
  ]

  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-1',
    runtime: 'pi',
    startedAt: 1000,
    endedAt: 2000,
    beforeCommitId: 'a'.repeat(40),
    afterCommitId: 'b'.repeat(40),
    diff: [
      { rootId: 'root-1', path: 'src/agent.ts', status: 'modified' },
      { rootId: 'root-1', path: 'src/bash-made.ts', status: 'added' },
      { rootId: 'root-1', path: 'src/user-edit.ts', status: 'modified' },
    ],
    evidence,
    roots: [root('root-1', rootPath)],
    partial: false,
  })

  expect(record.changes.map((change) => [change.path, change.attribution, change.evidenceSource])).toEqual([
    ['src/agent.ts', 'confirmed', 'write'],
    ['src/bash-made.ts', 'confirmed', 'bash'],
    ['src/user-edit.ts', 'unconfirmed', undefined],
  ])
  expect(record.changes[0]?.absolutePath).toBe('/tmp/workspace-root/src/agent.ts')
  expect(record.changes[0]?.evidenceSeq).toEqual([1])
  expect(record.unchangedEvidence).toEqual([])
})

test('证据写到根外：记进 unchangedEvidence 且标记 outside-roots', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-2',
    runtime: 'claude',
    startedAt: 1000,
    endedAt: 2000,
    diff: [],
    evidence: [
      { seq: 1, path: '/tmp/elsewhere/notes.md', source: 'write', toolName: 'Write' },
      { seq: 2, path: '/tmp/workspace-root/src/noop.ts', source: 'edit', toolName: 'Edit' },
    ],
    roots: [root('root-1', '/tmp/workspace-root')],
    partial: false,
  })

  expect(record.changes).toEqual([])
  expect(record.unchangedEvidence.map((item) => [item.reason, item.seq])).toEqual([
    ['outside-roots', 1],
    ['no-net-change', 2],
  ])
})

test('/private 前缀差异不算不同路径（macOS /var 与 /private/var）', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-3',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: [{ rootId: 'root-1', path: 'a.ts', status: 'modified' }],
    evidence: [{ seq: 1, path: '/private/var/tmp/root/a.ts', source: 'edit' }],
    roots: [root('root-1', '/var/tmp/root')],
    partial: false,
  })
  expect(record.changes[0]?.attribution).toBe('confirmed')
})

test('同一路径被写多次：保留全部证据序号，不折叠成最后一次', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-4',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: [{ rootId: 'root-1', path: 'a.ts', status: 'modified' }],
    evidence: [
      { seq: 1, path: '/r/a.ts', source: 'edit' },
      { seq: 2, path: '/r/a.ts', source: 'edit' },
    ],
    roots: [root('root-1', '/r')],
    partial: false,
  })
  expect(record.changes[0]?.evidenceSeq).toEqual([1, 2])
})

test('没有 diff 时也落记录，并写明原因', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-5',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: null,
    evidence: [],
    roots: [],
    partial: true,
    note: '没有可用的结束边界',
  })
  expect(record.changes).toEqual([])
  expect(record.note).toBe('没有可用的结束边界')
  expect(record.partial).toBe(true)
  // tree 路径还原必须与 tree 里的写法一致，否则上层无法按路径找对象。
  expect(shadowTurnChangeTreePath({ rootId: 'root-1', path: 'a/b.ts' } as never)).toBe('roots/root-1/a/b.ts')
})

test('存储：追加、按会话过滤、按 turn 精确定位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-store-'))
  try {
    const base = {
      schemaVersion: 1 as const,
      workspaceId: WORKSPACE_ID,
      runtime: 'pi',
      startedAt: 1,
      endedAt: 2,
      changes: [],
      unchangedEvidence: [],
      boundarySource: 'shadow-git' as const,
      roots: [],
      partial: false,
    }
    appendShadowTurnAttribution(dir, { ...base, sessionId: SESSION_ID, turnId: 'u1' })
    appendShadowTurnAttribution(dir, { ...base, sessionId: SESSION_ID, turnId: 'u2' })
    appendShadowTurnAttribution(dir, { ...base, sessionId: 'other', turnId: 'u3' })

    expect(readShadowTurnAttributions(dir).map((record) => record.turnId)).toEqual(['u1', 'u2', 'u3'])
    expect(readShadowTurnAttributions(dir, { sessionId: SESSION_ID }).map((record) => record.turnId)).toEqual(['u1', 'u2'])
    expect(readShadowTurnAttributions(dir, { limit: 2 }).map((record) => record.turnId)).toEqual(['u2', 'u3'])
    expect(findShadowTurnAttribution(dir, SESSION_ID, 'u2')?.turnId).toBe('u2')
    expect(findShadowTurnAttribution(dir, SESSION_ID, 'missing')).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存储：损坏行被跳过而不是整份不可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-corrupt-'))
  try {
    appendShadowTurnAttribution(dir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: 'ok-1',
      runtime: 'pi',
      startedAt: 1,
      endedAt: 2,
      changes: [],
      unchangedEvidence: [],
      boundarySource: 'shadow-git' as const,
      roots: [],
      partial: false,
    })
    writeFileSync(join(dir, 'turns.jsonl'), `${join(dir, 'turns.jsonl') && '{"broken":'}\n`, { flag: 'a' })
    expect(readShadowTurnAttributions(dir).map((record) => record.turnId)).toEqual(['ok-1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 归属文件压缩 ----

/** 造一条体积可观（note 填充）的最小归属记录，方便用小阈值观察压缩行为。 */
function compactableRecord(sessionId: string, index: number, noteSize = 120): ShadowTurnAttributionRecord {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    sessionId,
    turnId: `${sessionId}-${index}`,
    runtime: 'pi',
    startedAt: index,
    endedAt: index,
    changes: [],
    unchangedEvidence: [],
    boundarySource: 'shadow-git',
    roots: [],
    partial: false,
    note: 'x'.repeat(noteSize),
  }
}

test('压缩：按会话保留最近记录，压到目标大小以内，之后不再反复压缩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-compact-'))
  try {
    // 两个会话交错追加：全局只留最近 N 条会把靠前的会话整段切断。
    for (let index = 0; index < 20; index += 1) {
      appendShadowTurnAttribution(dir, compactableRecord('session-a', index))
      appendShadowTurnAttribution(dir, compactableRecord('session-b', index))
    }
    const file = join(dir, 'turns.jsonl')
    // 坏行：压缩时必须跳过，且不能让整份文件不可读。
    writeFileSync(file, '{"broken":\n', { flag: 'a' })

    const beforeBytes = statSync(file).size
    const maxBytes = Math.floor(beforeBytes / 2)
    const targetBytes = Math.floor(maxBytes / 2)
    const compacted = compactShadowAttributions(file, { maxBytes, targetBytes, keepPerSession: 3 })

    expect(compacted.compacted).toBe(true)
    expect(compacted.beforeBytes).toBe(beforeBytes)
    expect(statSync(file).size).toBe(compacted.afterBytes)
    expect(compacted.afterBytes).toBeLessThanOrEqual(targetBytes)

    const kept = readShadowTurnAttributions(dir)
    const sessionA = kept.filter((record) => record.sessionId === 'session-a').map((record) => record.turnId)
    const sessionB = kept.filter((record) => record.sessionId === 'session-b').map((record) => record.turnId)
    // 两个会话都保留，且各自保留的是最近的几条。
    expect(sessionA).toEqual(['session-a-17', 'session-a-18', 'session-a-19'])
    expect(sessionB).toEqual(['session-b-17', 'session-b-18', 'session-b-19'])
    expect(readFileSync(file, 'utf8')).not.toContain('{"broken"')

    // 紧接着再 append：文件仍低于阈值，不会再次触发压缩（旧记录一条不少）。
    appendShadowTurnAttribution(dir, compactableRecord('session-c', 1))
    const afterAppend = readShadowTurnAttributions(dir).map((record) => record.turnId)
    expect(afterAppend.sort()).toEqual(
      ['session-a-17', 'session-a-18', 'session-a-19', 'session-b-17', 'session-b-18', 'session-b-19', 'session-c-1'].sort(),
    )
    const contentAfterAppend = readFileSync(file, 'utf8')
    expect(maybeCompactShadowAttributions(file, { maxBytes })).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(contentAfterAppend)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('压缩：全局裁剪从最旧记录开始，最新记录始终保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-compact-trim-'))
  try {
    for (let index = 0; index < 10; index += 1) {
      appendShadowTurnAttribution(dir, compactableRecord('session-a', index))
    }
    const file = join(dir, 'turns.jsonl')
    const beforeBytes = statSync(file).size
    const targetBytes = Math.floor(beforeBytes / 3)
    const compacted = compactShadowAttributions(file, {
      maxBytes: Math.floor(beforeBytes / 2),
      targetBytes,
      // 关掉按会话裁剪，只观察全局裁剪。
      keepPerSession: 100,
    })

    expect(compacted.compacted).toBe(true)
    expect(compacted.afterBytes).toBeLessThanOrEqual(targetBytes)
    const keptIds = readShadowTurnAttributions(dir).map((record) => record.turnId)
    expect(keptIds).toContain('session-a-9')
    expect(keptIds).not.toContain('session-a-0')
    // 保留下来的必须是连续的一段（从尾部往前裁剪，而不是随机丢）。
    expect(keptIds).toEqual(
      [...keptIds].sort((left, right) => Number(left.split('-')[2]) - Number(right.split('-')[2])),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('压缩：未超过阈值时不读改写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-compact-noop-'))
  try {
    appendShadowTurnAttribution(dir, compactableRecord('session-a', 0))
    const file = join(dir, 'turns.jsonl')
    const content = readFileSync(file, 'utf8')
    const maxBytes = Buffer.byteLength(content) * 2

    const compacted = compactShadowAttributions(file, { maxBytes })
    expect(compacted.compacted).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(maybeCompactShadowAttributions(file, { maxBytes })).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(content)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 真实 git 仓库 ----

function findGitPath(): string | null {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, executable))
    .find((candidate) => existsSync(candidate))
  if (fromPath) return fromPath
  return ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'].find((candidate) => existsSync(candidate)) ?? null
}

const gitPath = findGitPath()
const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

test.skipIf(!gitPath)(
  '两次采集之间改/增/删：diff 给出确定状态，且 previous* 由仓库自己带出',
  async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'profer-attribution-git-'))
    tempDirs.push(baseDir)
    const rootPath = join(baseDir, 'root')
    mkdirSync(join(rootPath, 'src'), { recursive: true })
    writeFileSync(join(rootPath, 'src', 'app.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(rootPath, 'keep.md'), '# keep\n', 'utf8')

    const repoDir = join(baseDir, 'shadow', 'repo.git')
    const repository = await WorkspaceShadowRepository.open({
      workspaceId: WORKSPACE_ID,
      repoDir,
      journalPath: join(baseDir, 'shadow', 'journal.json'),
      gitPath: gitPath!,
      tempDir: join(baseDir, 'shadow', 'tmp'),
    })
    const roots: ShadowRoot[] = [{ rootId: WORKSPACE_ID, rootPath, kind: 'project' }]

    const initial = await repository.capture({ reason: 'initial', roots })
    expect(initial.ok).toBe(true)
    expect(initial.previousCommitId).toBeUndefined()

    writeFileSync(join(rootPath, 'src', 'app.ts'), 'export const a = 2\n', 'utf8')
    writeFileSync(join(rootPath, 'src', 'added.ts'), 'export const b = 1\n', 'utf8')
    unlinkSync(join(rootPath, 'keep.md'))

    const after = await repository.capture({ reason: 'turn-after', roots })
    expect(after.ok).toBe(true)
    // before 必须是「上一次成功提交」，不能是这次自己的提交。
    expect(after.previousCommitId).toBe(initial.commitId)
    expect(after.previousTreeSha).toBe(initial.treeSha)

    const runner = createGitRunner({ gitPath: gitPath! })
    const diff = await diffShadowCommits(runner, repoDir, after.previousCommitId, after.commitId)
    expect(diff.ok).toBe(true)
    if (!diff.ok) return
    expect(diff.entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { rootId: WORKSPACE_ID, path: 'keep.md', status: 'deleted' },
      { rootId: WORKSPACE_ID, path: 'src/added.ts', status: 'added' },
      { rootId: WORKSPACE_ID, path: 'src/app.ts', status: 'modified' },
    ])

    // 没有证据时全部是 unconfirmed：树差异不能自己证明是谁改的。
    const record = buildShadowTurnAttribution({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: 'user-msg-git',
      runtime: 'pi',
      startedAt: 1,
      endedAt: 2,
      beforeCommitId: after.previousCommitId,
      afterCommitId: after.commitId,
      diff: diff.entries,
      evidence: [
        { seq: 1, toolName: 'Edit', path: join(rootPath, 'src', 'app.ts'), source: 'edit' },
        { seq: 2, toolName: 'Write', path: join(rootPath, 'src', 'added.ts'), source: 'write' },
      ],
      roots: [{ rootId: WORKSPACE_ID, rootPath, kind: 'project' }],
      partial: false,
    })
    expect(record.changes.map((change) => [change.path, change.attribution])).toEqual([
      ['keep.md', 'unconfirmed'],
      ['src/added.ts', 'confirmed'],
      ['src/app.ts', 'confirmed'],
    ])
  },
  30_000,
)

test.skipIf(!gitPath)('tree 未变化时 diff 为空，不产生空提交也不产生假变化', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'profer-attribution-noop-'))
  tempDirs.push(baseDir)
  const rootPath = join(baseDir, 'root')
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'a.md'), 'a\n', 'utf8')
  const repoDir = join(baseDir, 'shadow', 'repo.git')
  const repository = await WorkspaceShadowRepository.open({
    workspaceId: WORKSPACE_ID,
    repoDir,
    journalPath: join(baseDir, 'shadow', 'journal.json'),
    gitPath: gitPath!,
    tempDir: join(baseDir, 'shadow', 'tmp'),
  })
  const roots: ShadowRoot[] = [{ rootId: WORKSPACE_ID, rootPath, kind: 'project' }]

  const first = await repository.capture({ reason: 'initial', roots })
  const second = await repository.capture({ reason: 'turn-after', roots })
  expect(second.commitId).toBe(first.commitId)

  const runner = createGitRunner({ gitPath: gitPath! })
  const diff = await diffShadowCommits(runner, repoDir, second.previousCommitId, second.commitId)
  expect(diff.ok && diff.entries).toEqual([])
}, 30_000)

test('根集合变化：新增根标记 rootIntroduced，移除根不进入 changes', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-roots',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: [
      // 会话这次新附加了一个目录：里面的文件是「刚开始看」，不是 Agent 新建。
      { rootId: 'attached-2', path: 'notes.md', status: 'added' },
      // 主根里真实发生的一次修改。
      { rootId: 'root-1', path: 'app.ts', status: 'modified' },
      // 上一次的附加目录这次不再采集：整段消失不叫删除。
      { rootId: 'attached-1', path: 'old.md', status: 'deleted' },
    ],
    evidence: [],
    roots: [
      { rootId: 'root-1', rootPath: '/w', kind: 'project' },
      { rootId: 'attached-2', rootPath: '/notes', kind: 'attached' },
    ],
    previousRootIds: ['root-1', 'attached-1'],
    partial: false,
  })

  expect(record.roots.map((root) => root.rootId)).toEqual(['root-1', 'attached-2'])
  expect(record.rootSetChanges).toEqual({ added: ['attached-2'], removed: ['attached-1'] })
  expect(record.changes.map((change) => [change.rootId, change.path, change.rootIntroduced ?? false])).toEqual([
    ['attached-2', 'notes.md', true],
    ['root-1', 'app.ts', false],
  ])
})

test('根集合未知（首个 turn）时不做增删判定', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-first',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: [{ rootId: 'root-1', path: 'a.ts', status: 'added' }],
    evidence: [],
    roots: [{ rootId: 'root-1', rootPath: '/w', kind: 'project' }],
    partial: false,
  })
  expect(record.rootSetChanges).toBeUndefined()
  expect(record.changes[0]?.rootIntroduced).toBeUndefined()
})

test('分叉关系：同一新会话多次分叉取最后一条，其它会话读不到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-fork-'))
  try {
    appendShadowForkRelation(dir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      sourceSessionId: 'source-1',
      newSessionId: 'new-1',
      commitId: 'c1',
      upToMessageUuid: 'u1',
      at: 1,
    })
    appendShadowForkRelation(dir, {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      sourceSessionId: 'source-1',
      newSessionId: 'new-1',
      commitId: 'c2',
      at: 2,
    })
    expect(readShadowForkRelation(dir, 'new-1')?.commitId).toBe('c2')
    expect(readShadowForkRelation(dir, 'new-1')?.upToMessageUuid).toBeUndefined()
    expect(readShadowForkRelation(dir, 'other')).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('内容引用：同一条证据的 before/after 引用进入 changes 并去重', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-refs',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: [{ rootId: 'root-1', path: 'a.ts', status: 'modified' }],
    evidence: [
      { seq: 1, path: '/r/a.ts', source: 'edit', beforeRef: 'ref-1', afterRef: 'ref-2' },
      { seq: 2, path: '/r/a.ts', source: 'edit', beforeRef: 'ref-1', afterRef: 'ref-3' },
    ],
    roots: [root('root-1', '/r')],
    partial: false,
  })

  const change = record.changes[0]!
  expect(change.attribution).toBe('confirmed')
  // 同一份 before 内容被写两次：引用只记一次，避免 Phase 3 重复生成同一段 patch。
  expect(change.beforeRefs).toEqual(['ref-1'])
  expect(change.afterRefs).toEqual(['ref-2', 'ref-3'])
})

test('没有内容证据时不写空数组（避免下游把「没有」读成「空内容」）', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-noref',
    runtime: 'claude',
    startedAt: 1,
    endedAt: 2,
    diff: [{ rootId: 'root-1', path: 'a.ts', status: 'modified' }],
    evidence: [{ seq: 1, path: '/r/a.ts', source: 'write' }],
    roots: [root('root-1', '/r')],
    partial: false,
  })
  expect(record.changes[0]?.beforeRefs).toBeUndefined()
  expect(record.changes[0]?.afterRefs).toBeUndefined()
})

test('每条记录的边界来源都是 shadow-git（旧 Pi 检查点不会被伪装成归属）', () => {
  const record = buildShadowTurnAttribution({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'user-msg-source',
    runtime: 'pi',
    startedAt: 1,
    endedAt: 2,
    diff: [],
    evidence: [],
    roots: [root('root-1', '/r')],
    partial: false,
  })
  expect(record.boundarySource).toBe('shadow-git')
})

test('早期记录缺少 roots/changes 时读取边界补齐为空数组', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-attribution-legacy-'))
  try {
    writeFileSync(
      join(dir, 'turns.jsonl'),
      `${JSON.stringify({ schemaVersion: 1, workspaceId: 'w', sessionId: 's', turnId: 't', createdAt: 1 })}\n`,
      'utf8',
    )
    const [record] = readShadowTurnAttributions(dir)
    // 磁盘上的历史行不会自己长出字段；下游必须能假设它们是数组。
    expect(record?.roots).toEqual([])
    expect(record?.changes).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
