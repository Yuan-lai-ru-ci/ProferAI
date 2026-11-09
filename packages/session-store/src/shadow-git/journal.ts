import { existsSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type {
  ShadowCaptureReason,
  ShadowJournalEntry,
  ShadowJournalFile,
  ShadowJournalRoot,
  ShadowRootKind,
} from './types'

/**
 * 工作区 Shadow Git 的采集 journal。
 *
 * 存在的理由：采集分「建快照 → 写对象 → 合成 tree → 建 commit」多步，中途进程被杀
 * 会留下半成品。journal 在采开始就落一条 pending，完成/失败再改写，重启后据此判断
 * 「上次到底做到哪一步」，而不是靠猜测对象库里有什么。
 *
 * 可靠性约定：
 * - journal 只是诊断与恢复用的旁路数据，任何损坏都不能让工作区启动失败；
 * - 内存状态是唯一写入源，落盘失败必须回滚内存，否则后续读到的状态永远不在磁盘上。
 */

/** 保留上限。journal 只服务「重启后找最近状态」，再多就是噪声。 */
export const MAX_JOURNAL_ENTRIES = 200

const SCHEMA_VERSION = 1 as const

/**
 * 用 Record 而不是字符串数组做白名单：types.ts 新增枚举值时这里会直接编译失败，
 * 不会静默把新原因/新状态的历史记录当成非法数据丢掉。
 */
const REASON_GUARD: Record<ShadowCaptureReason, true> = {
  initial: true,
  'turn-before': true,
  'turn-after': true,
  'rewind-before': true,
  'rewind-after': true,
  'startup-reconcile': true,
  'fork-before': true,
}

const STATUS_GUARD: Record<ShadowJournalEntry['status'], true> = {
  pending: true,
  completed: true,
  failed: true,
}

const KIND_GUARD: Record<ShadowRootKind, true> = {
  managed: true,
  project: true,
  attached: true,
}

/** 一次 open 的结果：区分「文件不存在」和「文件坏了」，两者后续动作不同。 */
type LoadOutcome =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'ok'; entries: ShadowJournalEntry[] }

export class ShadowJournal {
  readonly path: string
  readonly workspaceId: string

  #entries: ShadowJournalEntry[]

  private constructor(path: string, workspaceId: string, entries: ShadowJournalEntry[]) {
    this.path = path
    this.workspaceId = workspaceId
    this.#entries = entries
  }

  /**
   * 读取（或初始化）journal。绝不 throw：坏文件留证后按空 journal 启动。
   */
  static open(path: string, workspaceId: string): ShadowJournal {
    return new ShadowJournal(path, workspaceId, loadEntries(path, workspaceId))
  }

  /** 记录一次采集开始；同 captureId 重复 begin 视为两次独立采集，由调用方负责去重。 */
  begin(input: { captureId: string; reason: ShadowCaptureReason; startedAt: number }): ShadowJournalEntry {
    const entry: ShadowJournalEntry = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: this.workspaceId,
      captureId: input.captureId,
      reason: input.reason,
      status: 'pending',
      startedAt: input.startedAt,
      roots: [],
    }
    this.#commit([...this.#entries, entry])
    return cloneEntry(entry)
  }

  /** 标记采集成功；captureId 不存在（或已终结）时静默忽略。 */
  complete(
    captureId: string,
    patch: { completedAt: number; commitId: string; treeSha: string; roots: ShadowJournalRoot[] },
  ): void {
    const index = findPendingIndex(this.#entries, captureId)
    const current = index < 0 ? undefined : this.#entries[index]
    if (!current) return
    const next: ShadowJournalEntry = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: current.workspaceId,
      captureId: current.captureId,
      reason: current.reason,
      status: 'completed',
      startedAt: current.startedAt,
      completedAt: patch.completedAt,
      commitId: patch.commitId,
      treeSha: patch.treeSha,
      // patch 来自本包内部，但仍按不信任输入归一化：脏 root 只丢该元素，不污染整条记录。
      roots: normalizeRoots(patch.roots),
    }
    const entries = [...this.#entries]
    entries[index] = next
    this.#commit(entries)
  }

  /** 标记采集失败；captureId 不存在（或已终结）时静默忽略。 */
  fail(captureId: string, error: string, completedAt: number): void {
    const index = findPendingIndex(this.#entries, captureId)
    const current = index < 0 ? undefined : this.#entries[index]
    if (!current) return
    const next: ShadowJournalEntry = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: current.workspaceId,
      captureId: current.captureId,
      reason: current.reason,
      status: 'failed',
      startedAt: current.startedAt,
      completedAt,
      roots: current.roots.map(cloneRoot),
      error,
    }
    const entries = [...this.#entries]
    entries[index] = next
    this.#commit(entries)
  }

  /** 最近一次成功采集；重启后仓库据此恢复 HEAD 视图。 */
  latestCompleted(): ShadowJournalEntry | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]
      if (entry && entry.status === 'completed') return cloneEntry(entry)
    }
    return undefined
  }

  /** 从旧到新返回；limit 表示「最新 N 条」而不是最旧 N 条。 */
  list(limit?: number): ShadowJournalEntry[] {
    if (limit !== undefined) {
      const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
      return this.#entries.slice(Math.max(0, this.#entries.length - count)).map(cloneEntry)
    }
    return this.#entries.map(cloneEntry)
  }

  /** 有 pending 说明上次采集没走完，调用方需要 reconcile。 */
  hasPending(): boolean {
    return this.#entries.some((entry) => entry.status === 'pending')
  }

  #commit(next: ShadowJournalEntry[]): void {
    const previous = this.#entries
    // 先提交内存：写盘前任何重入读都看到最新状态；写盘失败再由 catch 回滚，
    // 避免出现「内存说有、磁盘上没有」这种只在重启后才暴露的分叉。
    this.#entries = trimEntries(next)
    try {
      writeJournalFile(this.path, this.#entries)
    } catch (error) {
      this.#entries = previous
      throw new Error(`Shadow journal 写入失败: ${messageOf(error)}`, { cause: error })
    }
  }
}

/**
 * 裁剪到上限：只丢最旧的已完成/失败记录，pending 一律保留。
 *
 * pending 是恢复线索，丢掉就等于把「采集被打断」伪装成「没有采集过」。
 */
function trimEntries(entries: ShadowJournalEntry[]): ShadowJournalEntry[] {
  if (entries.length <= MAX_JOURNAL_ENTRIES) return entries
  let excess = entries.length - MAX_JOURNAL_ENTRIES
  const kept: ShadowJournalEntry[] = []
  for (const entry of entries) {
    if (excess > 0 && entry.status !== 'pending') {
      excess -= 1
      continue
    }
    kept.push(entry)
  }
  return kept
}

/** 同一 captureId 可能被重复 begin；complete/fail 只认最近一条 pending。 */
function findPendingIndex(entries: readonly ShadowJournalEntry[], captureId: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && entry.captureId === captureId && entry.status === 'pending') return index
  }
  return -1
}

function loadEntries(path: string, workspaceId: string): ShadowJournalEntry[] {
  const primary = readJournalFile(path, workspaceId, true)
  if (primary.kind === 'ok') return primary.entries
  // 主文件坏了就已经留证并降级为空：此时再去读 .tmp 只会读到更旧的状态，
  // 反而掩盖「上次写入损坏」这个事实。
  if (primary.kind === 'corrupt') return []

  // 主文件不存在时才看 `.tmp`：上次 rename 前被杀会留下完整的一次写入。
  const leftover = readJournalFile(`${path}.tmp`, workspaceId, false)
  return leftover.kind === 'ok' ? leftover.entries : []
}

function readJournalFile(path: string, workspaceId: string, primary: boolean): LoadOutcome {
  if (!existsSync(path)) return { kind: 'missing' }
  try {
    const raw = readFileSync(path, 'utf8')
    // 空文件等价于「还没写过」，不算损坏，免得每次启动都留一个 .corrupt 垃圾。
    if (!raw.trim()) return { kind: 'ok', entries: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('journal 根节点不是对象')
    const candidate = parsed as Record<string, unknown>
    if (candidate.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`journal schemaVersion 不受支持: ${String(candidate.schemaVersion)}`)
    }
    if (!Array.isArray(candidate.entries)) throw new Error('journal entries 不是数组')

    const entries: ShadowJournalEntry[] = []
    let dropped = 0
    for (const item of candidate.entries) {
      const entry = readEntry(item, workspaceId)
      if (!entry) {
        dropped += 1
        continue
      }
      entries.push(entry)
    }
    if (dropped > 0) {
      // 单条坏记录只丢弃它自己：其余历史仍然有价值，不该整文件判死。
      console.warn(`[Shadow Git] journal 丢弃 ${dropped} 条非法记录: ${path}`)
    }
    return { kind: 'ok', entries }
  } catch (error) {
    console.warn(`[Shadow Git] journal 不可用，降级为空 journal (${path}):`, error)
    if (primary) quarantine(path)
    return { kind: 'corrupt' }
  }
}

/** 留证而不是删除：用户排查「为什么历史断了一截」时需要原始字节。 */
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch (error) {
    console.warn(`[Shadow Git] journal 留证失败 (${path}):`, error)
  }
}

function readEntry(value: unknown, workspaceId: string): ShadowJournalEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== SCHEMA_VERSION) return undefined
  // journal 文件按工作区隔离；workspaceId 不匹配说明文件被复制/错放，不能信任。
  if (candidate.workspaceId !== workspaceId) return undefined
  if (typeof candidate.captureId !== 'string' || candidate.captureId.length === 0) return undefined
  if (!hasKey(REASON_GUARD, candidate.reason)) return undefined
  if (!hasKey(STATUS_GUARD, candidate.status)) return undefined
  if (!isFiniteNumber(candidate.startedAt)) return undefined

  const status = candidate.status
  const completedAt = candidate.completedAt
  if (completedAt !== undefined && !isFiniteNumber(completedAt)) return undefined
  const commitId = candidate.commitId
  if (commitId !== undefined && typeof commitId !== 'string') return undefined
  const treeSha = candidate.treeSha
  if (treeSha !== undefined && typeof treeSha !== 'string') return undefined
  const error = candidate.error
  if (error !== undefined && typeof error !== 'string') return undefined

  if (!Array.isArray(candidate.roots)) return undefined
  const roots: ShadowJournalRoot[] = []
  for (const item of candidate.roots) {
    const root = readRoot(item)
    if (!root) return undefined
    roots.push(root)
  }

  // 已完成记录必须自带 commit/tree，否则 latestCompleted 给出的 HEAD 是空壳；
  // 失败记录必须带原因，否则重启后无从判断恢复到哪一步。
  if (status === 'completed') {
    if (completedAt === undefined || !commitId || !treeSha) return undefined
  }
  if (status === 'failed') {
    if (completedAt === undefined || error === undefined) return undefined
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceId,
    captureId: candidate.captureId,
    reason: candidate.reason,
    status,
    startedAt: candidate.startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(commitId === undefined ? {} : { commitId }),
    ...(treeSha === undefined ? {} : { treeSha }),
    roots,
    ...(error === undefined ? {} : { error }),
  }
}

function readRoot(value: unknown): ShadowJournalRoot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.rootId !== 'string' || candidate.rootId.length === 0) return undefined
  if (typeof candidate.rootPath !== 'string' || candidate.rootPath.length === 0) return undefined
  if (!hasKey(KIND_GUARD, candidate.kind)) return undefined
  if (!isFiniteNumber(candidate.fileCount) || candidate.fileCount < 0) return undefined
  if (typeof candidate.treeSha !== 'string') return undefined
  const failures = candidate.failures
  if (!Array.isArray(failures) || !failures.every((item) => typeof item === 'string')) return undefined
  if (!isFiniteNumber(candidate.skippedCount) || candidate.skippedCount < 0) return undefined
  if (typeof candidate.partial !== 'boolean') return undefined
  return {
    rootId: candidate.rootId,
    rootPath: candidate.rootPath,
    kind: candidate.kind,
    fileCount: Math.floor(candidate.fileCount),
    treeSha: candidate.treeSha,
    failures: [...(failures as string[])],
    skippedCount: Math.floor(candidate.skippedCount),
    partial: candidate.partial,
  }
}

function normalizeRoots(roots: readonly ShadowJournalRoot[]): ShadowJournalRoot[] {
  const normalized: ShadowJournalRoot[] = []
  for (const root of roots) {
    const parsed = readRoot(root)
    if (parsed) normalized.push(parsed)
  }
  return normalized
}

function cloneEntry(entry: ShadowJournalEntry): ShadowJournalEntry {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceId: entry.workspaceId,
    captureId: entry.captureId,
    reason: entry.reason,
    status: entry.status,
    startedAt: entry.startedAt,
    ...(entry.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(entry.commitId === undefined ? {} : { commitId: entry.commitId }),
    ...(entry.treeSha === undefined ? {} : { treeSha: entry.treeSha }),
    roots: entry.roots.map(cloneRoot),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  }
}

function cloneRoot(root: ShadowJournalRoot): ShadowJournalRoot {
  return { ...root, failures: [...root.failures] }
}

/**
 * 原子写：同目录临时文件 → fsync → rename 覆盖。
 *
 * fsync 在 rename 之前是必须的：否则断电后可能出现「新文件已就位但内容为空」，
 * 那正是 journal 最不该丢的时刻。目录项的 fsync 不做（macOS 不支持且代价高），
 * 这里接受「rename 可能回退到上一版」的最坏情况——上一版本身就是合法 journal。
 */
function writeJournalFile(path: string, entries: readonly ShadowJournalEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const file: ShadowJournalFile = { schemaVersion: SCHEMA_VERSION, entries: [...entries] }
  const payload = `${JSON.stringify(file)}\n`
  const tempPath = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tempPath, 'wx', 0o600)
  try {
    const buffer = Buffer.from(payload, 'utf8')
    let offset = 0
    // writeSync 可能短写，循环到写满为止。
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset)
    }
    fsyncSync(fd)
  } catch (error) {
    closeQuietly(fd)
    unlinkQuietly(tempPath)
    throw error
  }
  closeSync(fd)
  try {
    renameSync(tempPath, path)
  } catch (error) {
    unlinkQuietly(tempPath)
    throw error
  }
}

function hasKey<K extends string>(guard: Record<K, true>, value: unknown): value is K {
  return typeof value === 'string' && Object.hasOwn(guard, value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    /* 关闭失败不影响原始错误 */
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* 临时文件可能根本没建出来 */
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
