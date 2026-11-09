#!/usr/bin/env bun
/**
 * Shadow Git「Phase 3 文件逆向回退」的真机验证（dev 实例）。
 *
 * 为什么是脚本而不是 bun test：这里要跑真实 git 仓库、真实文件系统权限位，
 * 并把 `restore-journal.jsonl` / 采集 journal 的先后顺序当成可验证事实；
 * 同时还要拿 `~/.profer-dev` 里**真实工作区**的 turns.jsonl 压一遍判定代码。
 *
 * 刻意不 import 主进程装配层（workspace-shadow-restore.ts / workspace-shadow-git.ts）：
 * 它们经 agent-workspace-manager 依赖 electron 的 safeStorage，普通 bun 进程无法加载。
 * 这里按同一套顺序在脚本内重建编排（保护快照 → pending → 写盘 → completed → rewind-after）。
 *
 * 用法：
 *   bun scripts/verify-shadow-restore-dev.ts            # 生命周期断言，结束清理探针
 *   bun scripts/verify-shadow-restore-dev.ts --keep     # 保留探针目录与 shadow 仓库
 *   bun scripts/verify-shadow-restore-dev.ts --real     # 只读统计真实 dev 记录（dryRun）
 *
 * 安全约定：
 * - 只写 `~/.profer-dev/workspace-shadow/shadow-p3-probe/`、
 *   `~/.profer-dev/agent-workspaces/shadow-p3-probe/` 与 `$TMPDIR/profer-shadow-p3-*`；
 * - `--real` 全程 `dryRun: true`，临时文件落在 /tmp，绝不写真实工作区；
 * - 触碰 `~/.profer`（正式实例）时直接拒绝运行。
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  WorkspaceShadowRepository,
  appendShadowRestoreEntry,
  buildShadowTurnAttribution,
  cleanupRestoreTemp,
  createGitRunner,
  diffShadowCommits,
  findUnfinishedRestore,
  readShadowRestoreJournal,
  readShadowTurnAttributions,
  restoreShadowTurnChanges,
  type GitRunner,
  type ShadowRestoreEntry,
  type ShadowRestoreReason,
  type ShadowRoot,
  type ShadowTurnAttributionRecord,
} from '../packages/session-store/src/shadow-git'
import { workspaceShadowExclusions } from '../apps/electron/src/main/lib/workspace-shadow-exclusions'

const PROBE_WORKSPACE_ID = 'shadow-p3-probe'
const PROBE_SESSION_ID = 'probe-session'
const CONFIG_DIR = (process.env.PROFER_CONFIG_DIR?.trim() || join(homedir(), '.profer-dev')).replace(/\/+$/, '')

const GIT_PATH = (() => {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    if (existsSync(candidate)) return candidate
  }
  return 'git'
})()

interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

const checks: CheckResult[] = []

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

function assertConfigDir(): void {
  const resolved = resolve(CONFIG_DIR)
  if (resolved === join(homedir(), '.profer')) {
    throw new Error(`拒绝在正式实例上运行：${resolved}（只允许 ~/.profer-dev）`)
  }
  if (!resolved.includes('.profer-dev')) {
    throw new Error(`配置目录不在 dev 实例下：${resolved}`)
  }
}

interface ProbePaths {
  workspaceDir: string
  rootPath: string
  shadowDir: string
  repoDir: string
}

function probePaths(): ProbePaths {
  const workspaceDir = join(CONFIG_DIR, 'agent-workspaces', PROBE_WORKSPACE_ID)
  const shadowDir = join(CONFIG_DIR, 'workspace-shadow', PROBE_WORKSPACE_ID)
  return {
    workspaceDir,
    rootPath: join(workspaceDir, 'root'),
    shadowDir,
    repoDir: join(shadowDir, 'repo.git'),
  }
}

interface ProbeContext {
  paths: ProbePaths
  repository: WorkspaceShadowRepository
  runner: GitRunner
  roots: ShadowRoot[]
  rootPaths: Map<string, string>
}

async function openProbeRepository(paths: ProbePaths): Promise<WorkspaceShadowRepository> {
  return WorkspaceShadowRepository.open({
    workspaceId: PROBE_WORKSPACE_ID,
    repoDir: paths.repoDir,
    journalPath: join(paths.shadowDir, 'journal.json'),
    gitPath: GIT_PATH,
    tempDir: join(paths.shadowDir, 'tmp'),
    // 与主进程装配层同一套规则：Profer 私有目录不进基线。
    excludeAbsolutePaths: () => [
      paths.shadowDir,
      ...workspaceShadowExclusions({ storageMode: 'project', rootPath: paths.rootPath }),
    ],
  })
}

function writeProbeFile(rootPath: string, relativePath: string, content: string, mode?: number): void {
  const target = join(rootPath, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  if (mode !== undefined) chmodSync(target, mode)
}

function modeOf(pathValue: string): number {
  return statSync(pathValue).mode & 0o777
}

interface TurnSetup {
  files?: Record<string, string>
  mutate: (rootPath: string) => void
  /** 受控写入证据（相对根路径）。 */
  evidence: string[]
  turnId: string
}

/** 用真实 API 造一条与生产路径同构的归属记录：before 采集 → 改写 → after 采集 → diff + 证据。 */
async function recordTurn(context: ProbeContext, setup: TurnSetup): Promise<{
  record: ShadowTurnAttributionRecord
  beforeCommitId: string
  afterCommitId: string
}> {
  if (setup.files) {
    for (const [relativePath, content] of Object.entries(setup.files)) {
      writeProbeFile(context.paths.rootPath, relativePath, content)
    }
  }
  const before = await context.repository.capture({ reason: 'turn-before', roots: context.roots })
  if (!before.ok) throw new Error(`turn-before 采集失败：${before.error ?? '未知'}`)
  setup.mutate(context.paths.rootPath)
  const after = await context.repository.capture({ reason: 'turn-after', roots: context.roots })
  if (!after.ok) throw new Error(`turn-after 采集失败：${after.error ?? '未知'}`)

  const diff = await diffShadowCommits(context.runner, context.paths.repoDir, before.commitId, after.commitId)
  if (!diff.ok) throw new Error(`计算 diff 失败：${diff.error}`)

  const record = buildShadowTurnAttribution({
    workspaceId: PROBE_WORKSPACE_ID,
    sessionId: PROBE_SESSION_ID,
    turnId: setup.turnId,
    turnIdSource: 'user-message',
    runtime: 'probe',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    beforeCommitId: before.commitId,
    afterCommitId: after.commitId,
    beforeTreeSha: before.treeSha,
    afterTreeSha: after.treeSha,
    diff: diff.entries,
    evidence: setup.evidence.map((relativePath, index) => ({
      seq: index + 1,
      toolName: 'edit',
      path: join(context.paths.rootPath, relativePath),
      source: 'edit' as const,
    })),
    roots: [{ rootId: PROBE_WORKSPACE_ID, rootPath: context.paths.rootPath, kind: 'project' }],
    partial: false,
  })
  return { record, beforeCommitId: before.commitId, afterCommitId: after.commitId }
}

async function runRestore(
  context: ProbeContext,
  record: ShadowTurnAttributionRecord,
  options: { dryRun?: boolean; label: string },
) {
  return restoreShadowTurnChanges({
    runner: context.runner,
    repoDir: context.paths.repoDir,
    tempDir: join(context.paths.shadowDir, 'tmp', `restore-${options.label}-${randomUUID()}`),
    record,
    rootPaths: context.rootPaths,
    ...(options.dryRun ? { dryRun: true } : {}),
  })
}

function describe(entries: ShadowRestoreEntry[]): string {
  return entries
    .map((entry) => `${entry.path}:${entry.action}/${entry.reason}`)
    .join(', ')
}

function entryOf(entries: ShadowRestoreEntry[], relativePath: string): ShadowRestoreEntry | undefined {
  return entries.find((entry) => entry.path === relativePath)
}

interface ShadowJournalEntryLike {
  reason?: string
  status?: string
}

function readCaptureJournal(shadowDir: string): ShadowJournalEntryLike[] {
  const file = join(shadowDir, 'journal.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: ShadowJournalEntryLike[] }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

/**
 * 与 workspace-shadow-restore.ts 相同的编排顺序：
 * 保护快照 → pending(计划) → 写盘 → completed(结论) → rewind-after。
 */
async function orchestratedRestore(
  context: ProbeContext,
  record: ShadowTurnAttributionRecord,
): Promise<{
  restoreId: string
  protectionCommitId: string
  result: Awaited<ReturnType<typeof restoreShadowTurnChanges>>
}> {
  const protection = await context.repository.capture({ reason: 'rewind-before', roots: context.roots })
  if (!protection.ok) throw new Error(`保护快照失败：${protection.error ?? '未知'}`)

  const restoreId = randomUUID()
  const tempDir = join(context.paths.shadowDir, 'tmp', `restore-${restoreId}`)
  const plan = await restoreShadowTurnChanges({
    runner: context.runner,
    repoDir: context.paths.repoDir,
    tempDir,
    record,
    rootPaths: context.rootPaths,
    dryRun: true,
  })

  appendShadowRestoreEntry(context.paths.shadowDir, {
    schemaVersion: 1,
    restoreId,
    workspaceId: PROBE_WORKSPACE_ID,
    sessionId: record.sessionId,
    turnId: record.turnId,
    status: 'pending',
    startedAt: Date.now(),
    protectionCommitId: protection.commitId,
    outcomes: plan.entries.map((entry) => ({ path: entry.path, action: entry.action, reason: entry.reason })),
  })

  let result: Awaited<ReturnType<typeof restoreShadowTurnChanges>>
  try {
    result = await restoreShadowTurnChanges({
      runner: context.runner,
      repoDir: context.paths.repoDir,
      tempDir,
      record,
      rootPaths: context.rootPaths,
    })
  } finally {
    cleanupRestoreTemp({ tempDir })
  }

  appendShadowRestoreEntry(context.paths.shadowDir, {
    schemaVersion: 1,
    restoreId,
    workspaceId: PROBE_WORKSPACE_ID,
    sessionId: record.sessionId,
    turnId: record.turnId,
    status: result.ok ? 'completed' : 'failed',
    startedAt: Date.now(),
    completedAt: Date.now(),
    protectionCommitId: protection.commitId,
    outcomes: result.entries.map((entry) => ({ path: entry.path, action: entry.action, reason: entry.reason })),
    counts: result.counts,
    ...(result.error ? { error: result.error } : {}),
  })

  if (result.counts.restored + result.counts.deleted > 0) {
    await context.repository.capture({ reason: 'rewind-after', roots: context.roots })
  }
  return { restoreId, protectionCommitId: protection.commitId, result }
}

async function runLifecycle(keep: boolean): Promise<void> {
  const paths = probePaths()
  // 只清自己的探针目录：影子仓库与探针工作区都是本脚本创建的。
  rmSync(paths.shadowDir, { recursive: true, force: true })
  rmSync(paths.workspaceDir, { recursive: true, force: true })
  mkdirSync(paths.rootPath, { recursive: true })

  const repository = await openProbeRepository(paths)
  const context: ProbeContext = {
    paths,
    repository,
    runner: createGitRunner({ gitPath: GIT_PATH }),
    roots: [{ rootId: PROBE_WORKSPACE_ID, rootPath: paths.rootPath, kind: 'project' }],
    rootPaths: new Map([[PROBE_WORKSPACE_ID, paths.rootPath]]),
  }

  // ---- 1 + 8: 正向撤销（带保护快照 / journal） ----
  try {
    const { record } = await recordTurn(context, {
      files: { 'a.md': 'line1\nline2\nline3\n' },
      mutate: (root) => writeFileSync(join(root, 'a.md'), 'line1\nAGENT-A\nline3\n', 'utf8'),
      evidence: ['a.md'],
      turnId: 'probe-turn-1',
    })
    const changed = record.changes.find((change) => change.path === 'a.md')
    check(
      '1a 归属记录形状',
      Boolean(changed) && changed?.status === 'modified' && changed?.attribution === 'confirmed',
      changed ? `${changed.status}/${changed.attribution}` : '缺少 a.md 变化',
    )

    // 用户 chmod 过：恢复必须保留当前模式（0744），不能回退成 0644。
    chmodSync(join(paths.rootPath, 'a.md'), 0o744)

    const { restoreId, result } = await orchestratedRestore(context, record)
    const entry = entryOf(result.entries, 'a.md')
    check(
      '1b 正向撤销',
      entry?.action === 'restore' && entry?.reason === 'restored-verbatim',
      describe(result.entries),
    )
    check(
      '1c 内容回到改动前',
      readFileSync(join(paths.rootPath, 'a.md'), 'utf8') === 'line1\nline2\nline3\n',
      JSON.stringify(readFileSync(join(paths.rootPath, 'a.md'), 'utf8')),
    )
    check(
      '1d 模式保持当前值 0744',
      modeOf(join(paths.rootPath, 'a.md')) === 0o744,
      `0${modeOf(join(paths.rootPath, 'a.md')).toString(8)}`,
    )

    // 8: 保护快照顺序 + pending 计划非空
    const captureEntries = readCaptureJournal(paths.shadowDir)
    const rewindBefore = captureEntries.findIndex((item) => item.reason === 'rewind-before')
    const rewindAfter = captureEntries.findIndex((item) => item.reason === 'rewind-after')
    check(
      '8a rewind-before 先于 rewind-after',
      rewindBefore >= 0 && rewindAfter >= 0 && rewindBefore < rewindAfter,
      `rewind-before=#${rewindBefore}, rewind-after=#${rewindAfter}`,
    )
    const restoreJournal = readShadowRestoreJournal(paths.shadowDir)
    const pending = restoreJournal.find((item) => item.restoreId === restoreId && item.status === 'pending')
    check(
      '8b pending 行 outcomes 非空',
      Boolean(pending && pending.outcomes && pending.outcomes.length > 0),
      pending ? `${pending.outcomes?.length ?? 0} 条计划，protection=${pending.protectionCommitId?.slice(0, 8) ?? '无'}` : '找不到 pending 行',
    )

    // 9: 同一 record 再跑一次 → 幂等
    const second = await runRestore(context, record, { label: 'idempotent' })
    const allSettled = second.entries.every(
      (item) => item.reason === 'already-restored' || item.action === 'keep-current',
    )
    check(
      '9 两次运行幂等',
      allSettled && readFileSync(join(paths.rootPath, 'a.md'), 'utf8') === 'line1\nline2\nline3\n',
      `${describe(second.entries)}；内容未变=${readFileSync(join(paths.rootPath, 'a.md'), 'utf8') === 'line1\nline2\nline3\n'}`,
    )

    // 10: journal 能读回，pending → completed 顺序
    const ordered = restoreJournal.filter((item) => item.restoreId === restoreId)
    const statuses = ordered.map((item) => item.status)
    check(
      '10 restore journal 读回且 pending→completed',
      statuses.length === 2 && statuses[0] === 'pending' && statuses[1] === 'completed',
      `restoreId=${restoreId.slice(0, 8)}, statuses=${JSON.stringify(statuses)}`,
    )
    // pending 行是历史证据（追加写不原地改），真正的判据是「没有结论」的回退不存在。
    const unfinished = findUnfinishedRestore(paths.shadowDir)
    check(
      '10b 无未完成回退',
      unfinished === undefined,
      unfinished ? `仍有 pending：${unfinished.restoreId.slice(0, 8)}` : 'findUnfinishedRestore = undefined',
    )
  } catch (error) {
    check('1/8/9/10 正向撤销编排', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 2: 用户改动非重合区域 → clean-merge ----
  try {
    const original = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n'
    const agentEdit = ['1', 'AGENT', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n'
    const userEdit = ['1', 'AGENT', '3', '4', '5', '6', '7', '8', 'USER', '10'].join('\n') + '\n'
    const { record } = await recordTurn(context, {
      files: { 'doc-merge.md': original },
      mutate: (root) => writeFileSync(join(root, 'doc-merge.md'), agentEdit, 'utf8'),
      evidence: ['doc-merge.md'],
      turnId: 'probe-turn-2',
    })
    writeFileSync(join(paths.rootPath, 'doc-merge.md'), userEdit, 'utf8')
    const result = await runRestore(context, record, { label: 'merge' })
    const entry = entryOf(result.entries, 'doc-merge.md')
    const final = readFileSync(join(paths.rootPath, 'doc-merge.md'), 'utf8')
    const expected = ['1', '2', '3', '4', '5', '6', '7', '8', 'USER', '10'].join('\n') + '\n'
    check(
      '2 非重合区域 clean-merge',
      entry?.action === 'restore' && entry?.reason === 'clean-merge' && final === expected,
      `${entry?.action}/${entry?.reason}；内容一致=${final === expected}`,
    )
  } catch (error) {
    check('2 clean-merge', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 3: 同一区域冲突 → 保留 current，不写冲突标记 ----
  try {
    const original = ['1', '2', '3', '4', '5'].join('\n') + '\n'
    const agentEdit = ['1', '2', 'AGENT', '4', '5'].join('\n') + '\n'
    const userEdit = ['1', '2', 'USER', '4', '5'].join('\n') + '\n'
    const { record } = await recordTurn(context, {
      files: { 'doc-conflict.md': original },
      mutate: (root) => writeFileSync(join(root, 'doc-conflict.md'), agentEdit, 'utf8'),
      evidence: ['doc-conflict.md'],
      turnId: 'probe-turn-3',
    })
    writeFileSync(join(paths.rootPath, 'doc-conflict.md'), userEdit, 'utf8')
    const result = await runRestore(context, record, { label: 'conflict' })
    const entry = entryOf(result.entries, 'doc-conflict.md')
    const final = readFileSync(join(paths.rootPath, 'doc-conflict.md'), 'utf8')
    check(
      '3 冲突保留 current 且无冲突标记',
      entry?.action === 'keep-current' &&
        entry?.reason === 'conflict-kept-current' &&
        final === userEdit &&
        !final.includes('<<<<<<<'),
      `${entry?.action}/${entry?.reason}；用户内容保留=${final === userEdit}；含标记=${final.includes('<<<<<<<')}`,
    )
  } catch (error) {
    check('3 conflict-kept-current', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 4: 新建后用户改过 → edited-after-turn ----
  try {
    const { record } = await recordTurn(context, {
      mutate: (root) => writeFileSync(join(root, 'new-after.md'), '# agent\n', 'utf8'),
      evidence: ['new-after.md'],
      turnId: 'probe-turn-4',
    })
    const userContent = '# agent\n用户补了一段\n'
    writeFileSync(join(paths.rootPath, 'new-after.md'), userContent, 'utf8')
    const result = await runRestore(context, record, { label: 'added-edited' })
    const entry = entryOf(result.entries, 'new-after.md')
    const exists = existsSync(join(paths.rootPath, 'new-after.md'))
    check(
      '4 新建后用户改过',
      entry?.action === 'keep-current' &&
        entry?.reason === 'edited-after-turn' &&
        exists &&
        readFileSync(join(paths.rootPath, 'new-after.md'), 'utf8') === userContent,
      `${entry?.action}/${entry?.reason}；文件存在=${exists}`,
    )
  } catch (error) {
    check('4 edited-after-turn', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 5: 删除后用户重建 → recreated-after-turn ----
  try {
    const { record } = await recordTurn(context, {
      files: { 'gone.md': '# gone\n' },
      mutate: (root) => rmSync(join(root, 'gone.md')),
      evidence: ['gone.md'],
      turnId: 'probe-turn-5',
    })
    const userContent = '# 用户重写\n'
    writeFileSync(join(paths.rootPath, 'gone.md'), userContent, 'utf8')
    const result = await runRestore(context, record, { label: 'deleted-recreated' })
    const entry = entryOf(result.entries, 'gone.md')
    check(
      '5 删除后用户重建',
      entry?.action === 'keep-current' &&
        entry?.reason === 'recreated-after-turn' &&
        readFileSync(join(paths.rootPath, 'gone.md'), 'utf8') === userContent,
      `${entry?.action}/${entry?.reason}；用户内容未动=${
        readFileSync(join(paths.rootPath, 'gone.md'), 'utf8') === userContent
      }`,
    )
  } catch (error) {
    check('5 recreated-after-turn', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 6: partial 记录 + added → partial-evidence，不删文件 ----
  try {
    const { record } = await recordTurn(context, {
      mutate: (root) => writeFileSync(join(root, 'partial-new.md'), '# partial\n', 'utf8'),
      evidence: ['partial-new.md'],
      turnId: 'probe-turn-6',
    })
    const partialRecord: ShadowTurnAttributionRecord = { ...record, partial: true }
    const result = await runRestore(context, partialRecord, { label: 'partial' })
    const entry = entryOf(result.entries, 'partial-new.md')
    const exists = existsSync(join(paths.rootPath, 'partial-new.md'))
    check(
      '6 partial 记录不删文件',
      entry?.action === 'skip' && entry?.reason === 'partial-evidence' && exists,
      `${entry?.action}/${entry?.reason}；文件存在=${exists}`,
    )
  } catch (error) {
    check('6 partial-evidence', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 7: 边界不可读 → boundary-unreadable，文件不动 ----
  try {
    const agentContent = 'line1\nAGENT-B\nline3\n'
    const { record } = await recordTurn(context, {
      files: { 'boundary.md': 'line1\nline2\nline3\n' },
      mutate: (root) => writeFileSync(join(root, 'boundary.md'), agentContent, 'utf8'),
      evidence: ['boundary.md'],
      turnId: 'probe-turn-7',
    })
    const brokenRecord: ShadowTurnAttributionRecord = {
      ...record,
      beforeCommitId: '0000000000000000000000000000000000000000',
    }
    const before = readFileSync(join(paths.rootPath, 'boundary.md'), 'utf8')
    const result = await runRestore(context, brokenRecord, { label: 'boundary' })
    const entry = entryOf(result.entries, 'boundary.md')
    const after = readFileSync(join(paths.rootPath, 'boundary.md'), 'utf8')
    check(
      '7 边界不可读则整轮跳过',
      entry?.action === 'skip' && entry?.reason === 'boundary-unreadable' && before === after,
      `${entry?.action}/${entry?.reason}；文件未动=${before === after}`,
    )
  } catch (error) {
    check('7 boundary-unreadable', false, error instanceof Error ? error.message : String(error))
  }

  // ---- 汇总 ----
  const failed = checks.filter((item) => !item.pass)
  console.log(`\n探针工作区: ${paths.rootPath}`)
  console.log(`shadow 仓库: ${paths.repoDir}`)
  console.log(`断言: ${checks.length - failed.length}/${checks.length} 通过`)

  if (keep) {
    console.log('--keep：保留探针目录与 shadow 仓库')
  } else {
    rmSync(paths.shadowDir, { recursive: true, force: true })
    rmSync(paths.workspaceDir, { recursive: true, force: true })
    console.log('已清理探针目录与 shadow 仓库')
  }
  if (failed.length > 0) {
    console.log(`失败项: ${failed.map((item) => item.name).join(' / ')}`)
    process.exitCode = 1
  }
}

// ===== --real：只读压测真实 dev 记录 =====

interface RealStats {
  workspaces: Array<{
    workspaceId: string
    records: number
    parsed: number
    changes: number
    confirmedChanges: number
    recordsWithRoots: number
    recordsMissingRoots: number
    dryRunErrors: number
    boundaryUnreadable: number
    reasons: Record<string, number>
  }>
  totals: {
    workspaces: number
    records: number
    parsed: number
    changes: number
    confirmedChanges: number
    recordsWithRoots: number
    recordsMissingRoots: number
    dryRunErrors: number
    boundaryUnreadable: number
    reasons: Record<string, number>
  }
}

function shadowWorkspaceIds(): string[] {
  const base = join(CONFIG_DIR, 'workspace-shadow')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(base, name, 'turns.jsonl')))
}

async function runReal(): Promise<void> {
  const runner = createGitRunner({ gitPath: GIT_PATH })
  const tmpRoot = join('/tmp', `profer-shadow-p3-real-${process.pid}`)
  mkdirSync(tmpRoot, { recursive: true })
  const stats: RealStats = {
    workspaces: [],
    totals: {
      workspaces: 0,
      records: 0,
      parsed: 0,
      changes: 0,
      confirmedChanges: 0,
      recordsWithRoots: 0,
      recordsMissingRoots: 0,
      dryRunErrors: 0,
      boundaryUnreadable: 0,
      reasons: {},
    },
  }

  for (const workspaceId of shadowWorkspaceIds()) {
    const shadowDir = join(CONFIG_DIR, 'workspace-shadow', workspaceId)
    const repoDir = join(shadowDir, 'repo.git')
    const records = readShadowTurnAttributions(shadowDir)
    const sums = stats.totals
    const row = {
      workspaceId,
      records: records.length,
      parsed: records.length,
      changes: 0,
      confirmedChanges: 0,
      recordsWithRoots: 0,
      recordsMissingRoots: 0,
      dryRunErrors: 0,
      boundaryUnreadable: 0,
      reasons: {} as Record<string, number>,
    }
    for (const [index, record] of records.entries()) {
      // 早期记录没有 roots 字段（schema 演进），真实数据的形状必须宽容对待。
      const roots = Array.isArray(record.roots) ? record.roots : []
      const changes = Array.isArray(record.changes) ? record.changes : []
      const rootPaths = new Map(roots.map((root) => [root.rootId, root.rootPath]))
      if (roots.length > 0) row.recordsWithRoots += 1
      else row.recordsMissingRoots += 1
      row.changes += changes.length
      row.confirmedChanges += changes.filter((change) => change.attribution === 'confirmed').length
      try {
        const result = await restoreShadowTurnChanges({
          runner,
          repoDir,
          tempDir: join(tmpRoot, workspaceId, `record-${index}`),
          record,
          rootPaths,
          dryRun: true,
        })
        for (const entry of result.entries) {
          const reason = entry.reason as ShadowRestoreReason
          row.reasons[reason] = (row.reasons[reason] ?? 0) + 1
          if (reason === 'boundary-unreadable') row.boundaryUnreadable += 1
        }
      } catch (error) {
        row.dryRunErrors += 1
        console.log(`  记录 ${record.sessionId}/${record.turnId} 判定抛错: ${String(error)}`)
      }
    }
    stats.workspaces.push(row)
    sums.workspaces += 1
    sums.records += row.records
    sums.parsed += row.parsed
    sums.changes += row.changes
    sums.confirmedChanges += row.confirmedChanges
    sums.recordsWithRoots += row.recordsWithRoots
    sums.recordsMissingRoots += row.recordsMissingRoots
    sums.dryRunErrors += row.dryRunErrors
    sums.boundaryUnreadable += row.boundaryUnreadable
    for (const [reason, count] of Object.entries(row.reasons)) {
      sums.reasons[reason] = (sums.reasons[reason] ?? 0) + count
    }
    console.log(
      `工作区 ${workspaceId.slice(0, 8)}: 记录 ${row.records}，change ${row.changes}（confirmed ${row.confirmedChanges}），有 roots ${row.recordsWithRoots}，无 roots ${row.recordsMissingRoots}，boundary-unreadable ${row.boundaryUnreadable}，抛错 ${row.dryRunErrors}`,
    )
  }

  const sortedReasons = Object.fromEntries(Object.entries(stats.totals.reasons).sort(([left], [right]) => left.localeCompare(right)))
  stats.totals.reasons = sortedReasons
  console.log(`REAL_TOTALS ${JSON.stringify(stats.totals)}`)
  console.log(`REAL_STATS ${JSON.stringify(stats)}`)
  rmSync(tmpRoot, { recursive: true, force: true })

  if (stats.totals.dryRunErrors > 0) process.exitCode = 1
}

// ===== 入口 =====

assertConfigDir()
const argv = process.argv.slice(2)
if (argv.includes('--real')) {
  await runReal()
} else {
  await runLifecycle(argv.includes('--keep'))
}
