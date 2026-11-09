/**
 * 文件逆向 patch（Phase 3）。
 *
 * 给定一条 turn 归属记录，把「这一轮 Agent 改过的内容」撤回到改动前，
 * 同时**不碰**用户之后自己做的修改。因此不是整文件覆盖，而是三方合并：
 *
 * ```text
 *   base   = 这一轮结束时的内容（Agent 的产物）
 *   ours   = 现在磁盘上的内容（可能被用户改过）
 *   theirs = 这一轮开始前的内容（要恢复的目标）
 *   → git merge-file ours base theirs
 * ```
 *
 * 判定顺序（顺序本身就是安全策略）：
 * 1. 没有受控写入证据 → 不动（Bash/外部进程/用户手改都归这一档）；
 * 2. 记录是 partial → 不删任何文件（只恢复、不删除）；
 * 3. 当前文件读不到/不是普通文件 → 不动（读失败不等于不存在）；
 * 4. 边界对象读不到 → 整轮降级为「只跳过」（不能把「读不到」当成「没这个文件」）；
 * 5. 当前内容与 Agent 产物相同 → 直接恢复；
 * 6. 不同 → 三方合并；冲突或无法合并 → 保留 current。
 *
 * 关键实现细节：
 * - 文件内容一律走字节流（`cat-file` 直接落盘），不经过 UTF-8 字符串，
 *   否则 GBK/Latin-1 文件会被静默替换成 U+FFFD；
 * - 相等判断用 blob sha 而不是读全文，大文件不会把主进程内存打爆；
 * - 写盘原子化（临时文件 + rename）并保留文件模式（可执行位、0600 权限）。
 */

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { GitRunner } from './git-command'
import { shadowTreePath } from './roots'
import type { ShadowTurnAttributionRecord, ShadowTurnChange } from './attribution'

/** 单文件参与三方合并的上限；超过就走「保留 current」而不是把内容塞进内存。 */
const DEFAULT_MAX_MERGE_BYTES = 4 * 1024 * 1024

export interface ShadowRestoreEntry {
  rootId: string
  path: string
  absolutePath: string
  status: ShadowTurnChange['status']
  action: 'restore' | 'delete' | 'keep-current' | 'skip'
  reason: ShadowRestoreReason
  /** 补充说明（冲突文件名、跳过原因细节），只用于诊断。 */
  detail?: string
}

export type ShadowRestoreReason =
  | 'restored-verbatim'
  | 'clean-merge'
  | 'conflict-kept-current'
  | 'edited-after-turn'
  | 'deleted-after-turn'
  | 'recreated-after-turn'
  | 'already-restored'
  | 'unconfirmed-change'
  | 'root-introduced'
  | 'partial-evidence'
  | 'preexisting-file'
  | 'current-unreadable'
  | 'boundary-unreadable'
  | 'missing-root'
  | 'unsafe-path'
  | 'merge-unavailable'
  | 'concurrent-modification'
  | 'write-failed'

export interface RestoreShadowTurnResult {
  ok: boolean
  entries: ShadowRestoreEntry[]
  counts: { restored: number; deleted: number; kept: number; skipped: number }
  error?: string
}

export interface RestoreShadowTurnInput {
  runner: GitRunner
  repoDir: string
  /** 存放 git blob 与合并输入的工作目录；调用方负责在结束后清理。 */
  tempDir: string
  record: ShadowTurnAttributionRecord
  /** rootId → 根绝对路径；缺失的根一律跳过（路径含义不确定时不动用户文件）。 */
  rootPaths: Map<string, string>
  /** true = 只计算计划不写盘（测试与诊断用）。 */
  dryRun?: boolean
  maxMergeBytes?: number
}

/** 树里的条目：mode 决定可执行位，sha 用于相等判断与取内容。 */
interface TreeEntry {
  mode: string
  sha: string
}

type TreeLookup =
  | { kind: 'found'; entry: TreeEntry }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

/**
 * 当前路径的状态。
 *
 * 三态而不是两态：`unknown`（读失败、权限不足、是目录/管道/符号链接）绝不能
 * 被当成 `absent`——否则「文件还在但我读不到」会被判成「文件不存在」进而被覆盖。
 */
type CurrentState =
  | { kind: 'file'; size: number; mode: number; identity: FileIdentity }
  | { kind: 'absent' }
  | { kind: 'unknown'; detail: string }

/** 文件身份：用于写盘前确认「这期间没人动过它」。 */
interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

function toModeNumber(mode: string): number | undefined {
  const parsed = Number.parseInt(mode, 8)
  if (!Number.isFinite(parsed)) return undefined
  // git 只存 100644 / 100755 / 120000 / 160000，取低 9 位权限位。
  return parsed & 0o777
}

/** 从某个 commit 的树里取条目；区分「路径不存在」与「整个 commit 读不到」。 */
async function lookupTreeEntry(
  runner: GitRunner,
  repoDir: string,
  commitId: string | undefined,
  treePath: string,
): Promise<TreeLookup> {
  if (!commitId) return { kind: 'absent' }
  const result = await runner.run(['ls-tree', '-z', commitId, '--', treePath], { gitDir: repoDir })
  if (!result.ok) return { kind: 'unreadable', detail: result.stderr.trim() || `exit=${String(result.code)}` }
  const record = result.stdout.split('\0').find((item) => item.trim().length > 0)
  if (!record) return { kind: 'absent' }
  // 格式：`<mode> <type> <sha>\t<path>`
  const [meta] = record.split('\t')
  const parts = (meta ?? '').trim().split(/\s+/)
  const [mode, type, sha] = parts
  if (!mode || !type || !sha) return { kind: 'absent' }
  if (type !== 'blob') return { kind: 'unreadable', detail: `不是普通文件（${type}）` }
  return { kind: 'found', entry: { mode, sha } }
}

/** 当前路径的状态；只有 ENOENT/ENOTDIR 才算「不存在」。 */
function currentStateOf(absolutePath: string): CurrentState {
  try {
    const stat = lstatSync(absolutePath)
    if (stat.isSymbolicLink()) return { kind: 'unknown', detail: '路径是符号链接' }
    if (!stat.isFile()) return { kind: 'unknown', detail: '路径不是普通文件' }
    return {
      kind: 'file',
      size: stat.size,
      mode: stat.mode & 0o777,
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unknown', detail: `读取失败：${code ?? String(error)}` }
  }
}

/** 用 git 计算磁盘文件的 blob sha（流式哈希，不把文件读进内存）。 */
async function hashCurrentFile(runner: GitRunner, repoDir: string, absolutePath: string): Promise<string | undefined> {
  const result = await runner.run(['hash-object', '--no-filters', '--', absolutePath], { gitDir: repoDir })
  if (!result.ok) return undefined
  const sha = result.stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined
}

async function blobSize(runner: GitRunner, repoDir: string, sha: string): Promise<number | undefined> {
  const result = await runner.run(['cat-file', '-s', sha], { gitDir: repoDir })
  if (!result.ok) return undefined
  const size = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(size) ? size : undefined
}

/** 把 blob 原样写进临时文件（二进制安全）；返回是否成功。 */
async function writeBlobToFile(
  runner: GitRunner,
  repoDir: string,
  sha: string,
  destFile: string,
): Promise<boolean> {
  const result = await runner.run(['cat-file', 'blob', sha], { gitDir: repoDir, stdoutFile: destFile })
  return result.ok
}

function tempPathFor(tempDir: string, index: number, suffix: string): string {
  return join(tempDir, `restore-${index}-${suffix}`)
}

/**
 * 原子写：临时文件 → chmod → rename。
 *
 * rename 保留的是临时文件的权限，所以必须在 rename 之前 chmod，
 * 否则 0600 的私密文件会变成 0644（world-readable）。
 */
function writeFileAtomic(absolutePath: string, source: { bytes: Buffer } | { fromFile: string }, mode?: number): void {
  mkdirSync(dirname(absolutePath), { recursive: true })
  const temp = `${absolutePath}.profer-restore-${process.pid}-${Date.now()}`
  try {
    if ('bytes' in source) writeFileSync(temp, source.bytes)
    else copyFileSync(source.fromFile, temp)
    if (mode !== undefined) chmodSync(temp, mode)
    renameSync(temp, absolutePath)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* 临时文件可能没建出来 */
    }
    throw error
  }
}

/**
 * 写盘前确认文件没被换过。
 *
 * 判定与写盘之间隔着对 git 的若干次调用（合并时还隔着 merge-file），
 * 用户这期间的保存会被静默覆盖。dev/ino/size/mtime 任一变化都回落 keep-current：
 * 宁可少撤一点，也不能覆盖用户刚存下的内容。
 */
function identityChanged(absolutePath: string, expected: FileIdentity): boolean {
  try {
    const stat = lstatSync(absolutePath)
    return (
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.size !== expected.size ||
      Math.abs(stat.mtimeMs - expected.mtimeMs) > 0.5
    )
  } catch {
    // 文件消失了：同样是「状态变了」，交给调用方按 keep-current 处理。
    return true
  }
}

/**
 * 绝对路径必须落在根里：防御记录被改坏时把文件写到工作区外。
 *
 * 用 realpath 而不是只 resolve：根内某个目录段可能被换成指向根外的符号链接，
 * 纯字符串前缀会放行。目标文件可能还不存在，因此对「最近存在的祖先」取 realpath。
 */
function isInsideRoot(absolutePath: string, rootPath: string): boolean {
  const root = resolve(rootPath)
  const target = resolve(absolutePath)
  const inside = (value: string): boolean => value === root || value.startsWith(`${root}${sep}`)
  if (!inside(target)) return false
  try {
    const realRoot = realpathSyncNative(root)
    const realParent = realpathSyncNative(closestExistingAncestor(dirname(target)))
    return realParent === realRoot || realParent.startsWith(`${realRoot}${sep}`)
  } catch {
    // realpath 失败（权限、路径已消失）：退回字符串判定。
    return true
  }
}

function realpathSyncNative(value: string): string {
  return realpathSync.native(value)
}

function closestExistingAncestor(value: string): string {
  let current = value
  for (let depth = 0; depth < 64; depth += 1) {
    if (pathExistsNow(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return value
}

/** 同步确认路径存在（任何类型，含目录/链接）；lstat 不跟随符号链接。 */
function pathExistsNow(value: string): boolean {
  try {
    lstatSync(value)
    return true
  } catch {
    return false
  }
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0)
}

/**
 * 三方合并（字节安全）。
 *
 * `merge-file -p` 的输出**落盘再读**：stdout 字段是 UTF-8 字符串，GBK/Latin-1
 * 文件走一遍就会被整段替换成 U+FFFD，而且合并会被判成 clean-merge，问题被掩盖。
 */
async function mergeThreeWay(
  runner: GitRunner,
  files: { current: string; base: string; theirs: string; output: string },
): Promise<{ ok: true; file: string } | { ok: false; reason: 'conflict' | 'failed'; detail?: string }> {
  const result = await runner.run(['merge-file', '-p', files.current, files.base, files.theirs], {
    stdoutFile: files.output,
  })
  if (result.ok) return { ok: true, file: files.output }
  // git merge-file 的退出码是**冲突块数量**（1..127），255 之类才是真正的执行错误。
  // 只把 1 当冲突，会把「两处以上冲突」误报成工具不可用，reason 语义就错了。
  const code = result.code
  if (code !== null && code >= 1 && code < 128) return { ok: false, reason: 'conflict' }
  return { ok: false, reason: 'failed', detail: result.stderr.trim() || `exit=${String(result.code)}` }
}

function decide(
  change: ShadowTurnChange,
  action: ShadowRestoreEntry['action'],
  reason: ShadowRestoreReason,
  detail?: string,
): ShadowRestoreEntry {
  return {
    rootId: change.rootId,
    path: change.path,
    absolutePath: change.absolutePath,
    status: change.status,
    action,
    reason,
    ...(detail ? { detail } : {}),
  }
}

/**
 * partial 记录的不变量：**只恢复、不删除**。
 *
 * 快照不完整时（超限文件、不可读目录、枚举被截断），tree 里缺少某个路径不代表
 * Agent 删了它。所有会产生删除动作的分支都必须经过这个守卫：
 * - added：撤销动作是 unlink；
 * - modified 且 before 在树中缺失：撤销动作同样是 unlink。
 */
function deletionBlockedByPartial(record: ShadowTurnAttributionRecord): boolean {
  return record.partial
}

interface ChangeOutcome {
  entry: ShadowRestoreEntry
}

/**
 * 处理单条变化。
 *
 * 独立成函数是为了让「一个文件出错」只影响它自己：回退是尽量撤回能确认的部分，
 * 不是全有全无。抛出的异常会被上层转成 keep-current + write-failed。
 */
async function restoreOneChange(
  input: RestoreShadowTurnInput,
  change: ShadowTurnChange,
  index: number,
): Promise<ChangeOutcome> {
  const maxBytes = input.maxMergeBytes ?? DEFAULT_MAX_MERGE_BYTES
  const { record } = input

  if (change.attribution !== 'confirmed') {
    return { entry: decide(change, 'skip', 'unconfirmed-change') }
  }
  if (change.rootIntroduced) {
    return { entry: decide(change, 'skip', 'root-introduced') }
  }
  // partial 语义：只恢复、不删除。`added` 的撤销动作就是删除，因此整条跳过。
  if (deletionBlockedByPartial(record) && change.status === 'added') {
    return { entry: decide(change, 'skip', 'partial-evidence', '快照不完整，不删除文件') }
  }

  const rootPath = input.rootPaths.get(change.rootId)
  if (!rootPath) return { entry: decide(change, 'skip', 'missing-root') }
  const absolutePath = change.absolutePath || join(rootPath, change.path)
  if (!isInsideRoot(absolutePath, rootPath)) return { entry: decide(change, 'skip', 'unsafe-path') }

  const treePath = shadowTreePath(change.rootId, change.path)
  const before = await lookupTreeEntry(input.runner, input.repoDir, record.beforeCommitId, treePath)
  const after = await lookupTreeEntry(input.runner, input.repoDir, record.afterCommitId, treePath)
  // 边界读不到：把「读不到」当成「没有这个文件」会直接导致删错文件，整条降级。
  if (before.kind === 'unreadable' || after.kind === 'unreadable') {
    const detail = before.kind === 'unreadable' ? before.detail : (after as { detail: string }).detail
    return { entry: decide(change, 'skip', 'boundary-unreadable', detail) }
  }

  const current = currentStateOf(absolutePath)
  const currentSha =
    current.kind === 'file' ? await hashCurrentFile(input.runner, input.repoDir, absolutePath) : undefined
  // 能 stat 到但算不出摘要（权限、被独占、磁盘异常）：内容未知，任何写盘都是在赌。
  if (current.kind === 'file' && currentSha === undefined) {
    return { entry: decide(change, 'keep-current', 'current-unreadable', '无法计算当前文件摘要') }
  }
  const afterSha = after.kind === 'found' ? after.entry.sha : undefined
  const beforeSha = before.kind === 'found' ? before.entry.sha : undefined
  const sameAsAgent = currentSha !== undefined && afterSha !== undefined && currentSha === afterSha

  if (change.status === 'added') {
    if (current.kind === 'absent') return { entry: decide(change, 'skip', 'already-restored') }
    if (current.kind === 'unknown') {
      return { entry: decide(change, 'keep-current', 'current-unreadable', current.detail) }
    }
    if (change.preexisting) {
      // 树差异说是新增，但写入前已有内容：这个文件是用户自己建的，撤「新建」会删掉它。
      return { entry: decide(change, 'keep-current', 'preexisting-file') }
    }
    if (!sameAsAgent) {
      // Agent 新建、用户又改过：删除会连用户的修改一起删掉。
      return { entry: decide(change, 'keep-current', 'edited-after-turn') }
    }
    if (!input.dryRun) {
      if (identityChanged(absolutePath, current.identity)) {
        return { entry: decide(change, 'keep-current', 'concurrent-modification') }
      }
      unlinkSync(absolutePath)
    }
    return { entry: decide(change, 'delete', 'restored-verbatim') }
  }

  if (change.status === 'deleted') {
    if (current.kind === 'unknown') {
      return { entry: decide(change, 'keep-current', 'current-unreadable', current.detail) }
    }
    if (current.kind === 'file') {
      // Agent 删掉后用户重建了：恢复会覆盖用户的新内容。
      return { entry: decide(change, 'keep-current', 'recreated-after-turn') }
    }
    if (before.kind !== 'found') return { entry: decide(change, 'skip', 'already-restored') }
    if (!input.dryRun) {
      const temp = tempPathFor(input.tempDir, index, 'restore')
      if (!(await writeBlobToFile(input.runner, input.repoDir, before.entry.sha, temp))) {
        return { entry: decide(change, 'keep-current', 'merge-unavailable', '读取恢复内容失败') }
      }
      // 判定用的是 cat-file 之前的 lstat 结果：用户可能在这个 await 窗口里新建了同名文件。
      // writeFileAtomic 内部是 copy + rename，会**静默覆盖**已存在目标，所以写盘前必须同步复核；
      // 复核与 writeFileAtomic 之间不得有 await，否则窗口会重新打开。
      if (pathExistsNow(absolutePath)) {
        return { entry: decide(change, 'keep-current', 'concurrent-modification', '恢复过程中目标被创建') }
      }
      writeFileAtomic(absolutePath, { fromFile: temp }, toModeNumber(before.entry.mode))
    }
    return { entry: decide(change, 'restore', 'restored-verbatim') }
  }

  // modified
  if (current.kind === 'unknown') {
    return { entry: decide(change, 'keep-current', 'current-unreadable', current.detail) }
  }
  if (current.kind === 'absent') {
    // 用户在此之后把文件删了：复活它会违背用户的当前意图。
    return { entry: decide(change, 'keep-current', 'deleted-after-turn') }
  }
  if (sameAsAgent) {
    if (before.kind !== 'found') {
      // 撤销动作是 unlink：partial 记录下「before 里没有」不能当成删除证据。
      if (deletionBlockedByPartial(record)) {
        return { entry: decide(change, 'skip', 'partial-evidence', '快照不完整，不删除文件') }
      }
      if (!input.dryRun) {
        if (identityChanged(absolutePath, current.identity)) {
          return { entry: decide(change, 'keep-current', 'concurrent-modification') }
        }
        unlinkSync(absolutePath)
      }
      return { entry: decide(change, 'delete', 'restored-verbatim') }
    }
    if (!input.dryRun) {
      const temp = tempPathFor(input.tempDir, index, 'restore')
      if (!(await writeBlobToFile(input.runner, input.repoDir, before.entry.sha, temp))) {
        return { entry: decide(change, 'keep-current', 'merge-unavailable', '读取恢复内容失败') }
      }
      if (!input.dryRun && identityChanged(absolutePath, current.identity)) {
        return { entry: decide(change, 'keep-current', 'concurrent-modification') }
      }
      // 保留用户当前文件的权限（可能已被 chmod 过），只替换内容。
      writeFileAtomic(absolutePath, { fromFile: temp }, current.mode)
    }
    return { entry: decide(change, 'restore', 'restored-verbatim') }
  }

  // 当前内容已经不是 Agent 的产物：三方合并。
  if (current.size > maxBytes) {
    return { entry: decide(change, 'keep-current', 'merge-unavailable', '文件超过合并上限') }
  }
  const afterSize = afterSha ? await blobSize(input.runner, input.repoDir, afterSha) : undefined
  const beforeSize = beforeSha ? await blobSize(input.runner, input.repoDir, beforeSha) : undefined
  if ((afterSize ?? 0) > maxBytes || (beforeSize ?? 0) > maxBytes) {
    return { entry: decide(change, 'keep-current', 'merge-unavailable', '文件超过合并上限') }
  }
  if (!beforeSha || !afterSha) {
    return { entry: decide(change, 'keep-current', 'merge-unavailable', '缺少合并输入') }
  }

  const baseFile = tempPathFor(input.tempDir, index, 'base')
  const theirsFile = tempPathFor(input.tempDir, index, 'theirs')
  if (
    !(await writeBlobToFile(input.runner, input.repoDir, afterSha, baseFile)) ||
    !(await writeBlobToFile(input.runner, input.repoDir, beforeSha, theirsFile))
  ) {
    return { entry: decide(change, 'keep-current', 'merge-unavailable', '读取合并输入失败') }
  }
  const currentBytes = readFileSync(absolutePath)
  const baseBytes = readFileSync(baseFile)
  const theirsBytes = readFileSync(theirsFile)
  if (looksBinary(currentBytes) || looksBinary(baseBytes) || looksBinary(theirsBytes)) {
    return { entry: decide(change, 'keep-current', 'merge-unavailable', '二进制文件') }
  }

  const output = tempPathFor(input.tempDir, index, 'merged')
  const merged = await mergeThreeWay(input.runner, {
    current: absolutePath,
    base: baseFile,
    theirs: theirsFile,
    output,
  })
  if (!merged.ok) {
    return {
      entry: decide(
        change,
        'keep-current',
        merged.reason === 'conflict' ? 'conflict-kept-current' : 'merge-unavailable',
        merged.reason === 'conflict' ? '重合区域冲突，保留当前内容' : merged.detail,
      ),
    }
  }
  const mergedBytes = readFileSync(merged.file)
  if (mergedBytes.equals(currentBytes)) {
    return { entry: decide(change, 'skip', 'already-restored') }
  }
  if (!input.dryRun) {
    if (identityChanged(absolutePath, current.identity)) {
      return { entry: decide(change, 'keep-current', 'concurrent-modification') }
    }
    writeFileAtomic(absolutePath, { fromFile: merged.file }, current.mode)
  }
  return { entry: decide(change, 'restore', 'clean-merge') }
}

/**
 * 执行一个 turn 的逆向 patch。
 *
 * 单个文件失败不影响其它文件（异常转成 keep-current + write-failed）。
 */
export async function restoreShadowTurnChanges(input: RestoreShadowTurnInput): Promise<RestoreShadowTurnResult> {
  mkdirSync(input.tempDir, { recursive: true })
  const entries: ShadowRestoreEntry[] = []

  for (const [offset, change] of input.record.changes.entries()) {
    try {
      entries.push((await restoreOneChange(input, change, offset + 1)).entry)
    } catch (error) {
      entries.push(
        decide(change, 'keep-current', 'write-failed', error instanceof Error ? error.message : String(error)),
      )
    }
  }

  const counts = { restored: 0, deleted: 0, kept: 0, skipped: 0 }
  for (const entry of entries) {
    if (entry.action === 'restore') counts.restored += 1
    else if (entry.action === 'delete') counts.deleted += 1
    else if (entry.action === 'keep-current') counts.kept += 1
    else counts.skipped += 1
  }

  return { ok: true, entries, counts }
}

/** 清理合并用的临时文件；失败不影响回退结论。 */
export function cleanupRestoreTemp(input: { tempDir: string }): void {
  try {
    rmSync(input.tempDir, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉留给系统回收 */
  }
}
