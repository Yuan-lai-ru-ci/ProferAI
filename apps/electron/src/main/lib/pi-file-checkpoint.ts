import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import {
  checkpointRef,
  commitTree,
  countRepoBytes,
  deleteRef,
  diffTrees,
  ensureShadowRepo,
  fromGitPath,
  gcShadowRepo,
  importRefFromRepo,
  isCheckpointRef,
  isGitSnapshotAvailable,
  isObjectId,
  isShadowRepoDirName,
  listCheckpointRefs,
  removeShadowRepo,
  restorePathsFromTree,
  shadowRepoDirFor,
  snapshotPaths,
  toGitPath,
  updateRef,
} from './pi-checkpoint-git'

/**
 * Pi 文件检查点。
 *
 * Pi 运行时没有 Claude SDK 的 file-history-snapshot，Profer 只能在每轮开始前做一次基线快照，
 * 用于 rewind/fork 时恢复文件。这里融合了两套成熟做法：
 *
 * 1. **引擎**：社区共识的 git 对象快照 —— 每个会话一个私有 bare 影子仓库（`--work-tree` 指向
 *    会话 cwd，因此工作区不必是 git 仓库、也绝不碰用户仓库），快照 = 显式路径 `add -f` →
 *    `write-tree` → `commit-tree` → 一个检查点 ref。只存增量对象，tree diff 直接给出
 *    「新增/修改/删除」清单，tree SHA 直接用于 dedup。删 ref 即可让 git 回收对象。
 * 2. **策略**：Profer 自己的确定性排除规则、占用/权限容错、`skipped`/`partial` 保护语义、
 *    回收与磁盘预算。这些是 git 本身不提供的，也正是「回退不会误删」的保证来源。
 *
 * git 不可用（未安装/初始化失败/工作区含会改写内容的 .gitattributes）时**自动降级为全量复制**，
 * 检查点格式保持向后兼容（v1 纯数组 / v2 复制目录 / v3 git），任何情况下都不让整轮任务失败。
 */

/** 永不进入的目录：无回退价值，且体积通常巨大或会自我递归。 */
const NEVER_ENTER_DIRS = new Set(['.git', 'node_modules', '.profer-pi-checkpoints', '.claude'])

/**
 * 可再生成的构建/缓存目录：快照它们只会让基线体积失控。
 *
 * 只收那些几乎不存放源码的目录；`build` / `out` 在 CMake、Gradle 等工程里常放源码，
 * 过度排除会让回退变得不完整，因此不列入（被排除内容的代价不对等：少捕获只会回退不全，不会丢数据）。
 */
const DERIVED_DIRS = new Set([
  '.cache',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'coverage',
  'dist',
  'target',
  'venv',
])

/** 纯锁/系统噪音文件：复制或哈希都只会撞上占用错误，内容对回退也没有价值。 */
const SKIP_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'LOCK',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
])

/** Chromium 系 profile 根目录的特征文件；配合 Default / Profile N 子目录判定。 */
const CHROMIUM_PROFILE_MARKER = 'Local State'

/** 会改写文件内容的 .gitattributes 指令：命中即放弃 git 引擎，避免还原时丢字节。 */
const CONTENT_REWRITING_ATTRIBUTES = /\b(text|filter|eol|working-tree-encoding|ident)\b/

/** 单文件快照上限：超过即跳过并记入 skipped，避免把数据库/视频/模型权重每轮搬一遍。 */
export const MAX_SNAPSHOT_FILE_BYTES = 50 * 1024 * 1024

/** 单次快照总字节上限：超过即停止收集并标记 partial，回退时退化为「只恢复、不删除」。 */
export const MAX_SNAPSHOT_TOTAL_BYTES = 1024 * 1024 * 1024

/** 单个会话保留的检查点数量/字节上限，超出后从最旧的开始回收。 */
export const MAX_CHECKPOINTS_PER_SESSION = 40
export const MAX_CHECKPOINT_BYTES_PER_SESSION = 2 * 1024 * 1024 * 1024

const COPY_RETRY_DELAYS_MS = [0, 40, 120, 300]
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])
const MANIFEST_NAME = '.manifest.json'
/** 崩溃/中断留下的无清单目录，超过该时长即视为垃圾回收。 */
const ORPHAN_CHECKPOINT_TTL_MS = 10 * 60 * 1000

export type PiCheckpointEngine = 'git' | 'copy'
/** auto：优先 git 引擎，失败自动降级为全量复制 */
export type PiCheckpointMode = 'auto' | 'git' | 'copy'

export interface PiCheckpointSkip {
  /** 相对 cwd 的路径 */
  path: string
  /** file：单文件未快照；dir：目录未能遍历，其中文件状态未知 */
  kind: 'file' | 'dir'
  /** 跳过原因（错误码或体积说明），用于在回退结果中告知用户 */
  reason: string
}

export interface PiGitCheckpointRef {
  /** 影子仓库（bare）目录 */
  dir: string
  /** 快照时的工作区根目录 */
  workTree: string
  treeSha: string
  commitSha: string
  ref: string
  /** 快照时的体积上限：回退侧沿用同一套规则，保证基线与当前状态判定对称 */
  limits?: { maxFileBytes: number; maxTotalBytes: number }
}

export interface PiFileCheckpoint {
  /** 检查点标识：git 模式为清单 .json 文件，copy 模式为目录 */
  path: string
  engine: PiCheckpointEngine
  files: string[]
  /** 存在但未能快照的内容：它们属于基线，回退时不得被当作「本轮新增」删除 */
  skipped: PiCheckpointSkip[]
  /** 基线不完整（总字节超限提前停止收集），回退时整体跳过删除阶段 */
  partial: boolean
  /** 快照时生效的体积上限，恢复侧必须复用以维持对称性。 */
  limits?: { maxFileBytes: number; maxTotalBytes: number }
  git?: PiGitCheckpointRef
}

export interface PiRestoreResult {
  changed: string[]
  skipped: PiCheckpointSkip[]
  /** 基线未完整覆盖工作区，或恢复有遗留；UI 不得呈现为完全成功。 */
  incomplete: boolean
  /** 无法安全比较当前状态和基线，调用方不得把文件回退呈现为成功。 */
  failed?: boolean
}

export interface PiCheckpointOptions {
  maxFileBytes?: number
  maxTotalBytes?: number
  mode?: PiCheckpointMode
}

interface PiCheckpointManifestV3 {
  version: 3
  engine: 'git'
  treeSha: string
  commitSha: string
  ref: string
  dir: string
  cwd: string
  files: string[]
  skipped: PiCheckpointSkip[]
  partial: boolean
  bytes: number
  repoBytes: number
  createdAt: number
  limits?: { maxFileBytes: number; maxTotalBytes: number }
}

interface PiCheckpointManifestV2 {
  version: 2
  files: string[]
  skipped: PiCheckpointSkip[]
  partial: boolean
  bytes: number
  limits?: { maxFileBytes: number; maxTotalBytes: number }
}

interface CheckpointDescriptor {
  engine: PiCheckpointEngine
  files: string[]
  skipped: PiCheckpointSkip[]
  partial: boolean
  bytes: number
  repoBytes: number
  limits?: { maxFileBytes: number; maxTotalBytes: number }
  git?: PiGitCheckpointRef
}

function relativePath(root: string, path: string): string {
  return relative(root, path) || '.'
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}: ${message}` : message
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

/** 同步退避等待：快照链路整体是同步的，这里不能让出事件循环导致基线漂移。 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RETRYABLE_CODES.has(code)
}

function isSafeCheckpointPath(value: string, allowRoot = false): boolean {
  if (!value || isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) return false
  const segments = value.split(/[\\/]+/)
  if (allowRoot && value === '.') return true
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  const root = resolve('/profer-checkpoint-root')
  const target = resolve(root, value)
  const rel = relative(root, target)
  return Boolean(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

function isSkipEntry(value: unknown): value is PiCheckpointSkip {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<PiCheckpointSkip>
  return (
    typeof entry.path === 'string'
    && isSafeCheckpointPath(entry.path, entry.kind === 'dir')
    && (entry.kind === 'file' || entry.kind === 'dir')
    && typeof entry.reason === 'string'
  )
}

function validateManifestFiles(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((file): file is string => typeof file === 'string' && isSafeCheckpointPath(file))) {
    throw new Error('Pi 文件检查点清单包含无效路径')
  }
  return value
}

function safeWorkspacePath(root: string, checkpointPath: string): string {
  if (!isSafeCheckpointPath(checkpointPath)) throw new Error(`Pi 文件检查点路径越界: ${checkpointPath}`)
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, checkpointPath)
  const rel = relative(resolvedRoot, target)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error(`Pi 文件检查点路径越界: ${checkpointPath}`)
  }
  return target
}

function mergeSkipped(...groups: PiCheckpointSkip[][]): PiCheckpointSkip[] {
  const merged = new Map<string, PiCheckpointSkip>()
  for (const group of groups) {
    for (const item of group) merged.set(`${item.kind}:${item.path}`, item)
  }
  return [...merged.values()]
}

/** Chromium 系浏览器 user-data-dir：内含 cookies/history 等被浏览器进程独占锁定的 SQLite 库。 */
function isBrowserProfileDir(dir: string): boolean {
  try {
    if (!existsSync(join(dir, CHROMIUM_PROFILE_MARKER))) return false
    return existsSync(join(dir, 'Default')) || readdirSync(dir).some((name) => /^Profile \d+$/.test(name))
  } catch {
    return false
  }
}

/** 带退避重试的单文件复制：占用/权限类错误重试后仍失败则上报，交由调用方跳过。 */
function copyFileResilient(source: string, target: string): { ok: true } | { ok: false; reason: string } {
  let lastError: unknown
  for (const delay of COPY_RETRY_DELAYS_MS) {
    sleepSync(delay)
    try {
      if (!lstatSync(source).isFile()) throw new Error('检查点只允许复制常规文件')
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target)
      return { ok: true }
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) break
    }
  }
  return { ok: false, reason: describeError(lastError) }
}

/** 确认从 root 到目标父目录的现有节点都不是符号链接，并创建缺失父目录。 */
function prepareRestoreParent(root: string, checkpointPath: string): string {
  const target = safeWorkspacePath(root, checkpointPath)
  const rootPath = resolve(root)
  const parentSegments = relative(rootPath, dirname(target)).split(/[\\/]+/).filter(Boolean)
  let current = rootPath
  for (const segment of parentSegments) {
    current = join(current, segment)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`恢复路径经过符号链接: ${checkpointPath}`)
      if (!stat.isDirectory()) {
        rmSync(current, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        mkdirSync(current)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current)
    }
  }
  return target
}

/** 还原一个常规文件前清理同路径的目录/链接，避免 file ↔ directory 冲突与链接跟随。 */
function prepareRestoreFileTarget(root: string, checkpointPath: string): string {
  const target = prepareRestoreParent(root, checkpointPath)
  try {
    const stat = lstatSync(target)
    if (stat.isDirectory()) rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    else if (stat.isSymbolicLink()) unlinkSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

/** 删除当前工作区中由当前轮新增的常规文件或链接；拒绝穿越任意父级符号链接。 */
function removeWorkspaceFile(root: string, checkpointPath: string): void {
  const target = prepareRestoreParent(root, checkpointPath)
  const stat = lstatSync(target)
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`预期常规文件，实际是目录: ${checkpointPath}`)
  unlinkSync(target)
}

function restoreCopyFile(checkpointRoot: string, workspaceRoot: string, checkpointPath: string): { ok: true } | { ok: false; reason: string } {
  try {
    const source = safeWorkspacePath(checkpointRoot, checkpointPath)
    const sourceStat = lstatSync(source)
    if (!sourceStat.isFile()) return { ok: false, reason: '检查点文件不是常规文件' }
    const target = prepareRestoreFileTarget(workspaceRoot, checkpointPath)
    return copyFileResilient(source, target)
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  }
}

interface WalkResult {
  files: string[]
  skipped: PiCheckpointSkip[]
  bytes: number
  partial: boolean
  /** 存在会改写内容的 .gitattributes：git 引擎无法保证逐字节还原 */
  rewriteRisk: boolean
}

interface SnapshotLimits {
  maxFileBytes: number
  maxTotalBytes: number
}

function walk(root: string, limits: SnapshotLimits): WalkResult {
  const result: WalkResult = { files: [], skipped: [], bytes: 0, partial: false, rewriteRisk: false }
  visit(root)
  return result

  function visit(current: string): void {
    let names: string[]
    try {
      names = readdirSync(current)
    } catch (error) {
      // 目录读不到（权限/被占用）：其中文件状态未知，整个目录登记为 dir 级跳过
      result.skipped.push({ path: relativePath(root, current), kind: 'dir', reason: describeError(error) })
      return
    }
    if (names.includes('.gitattributes')) {
      try {
        if (CONTENT_REWRITING_ATTRIBUTES.test(readFileSync(join(current, '.gitattributes'), 'utf8'))) {
          result.rewriteRisk = true
        }
      } catch {
        /* 读不到就按不存在处理 */
      }
    }
    for (const name of names) {
      if (result.partial) return
      const path = join(current, name)
      let stat
      try {
        stat = lstatSync(path)
      } catch (error) {
        result.skipped.push({ path: relativePath(root, path), kind: 'file', reason: describeError(error) })
        continue
      }
      if (stat.isSymbolicLink()) {
        // 绝不跟随符号链接 / Windows junction：checkpoint 的写入边界只限 cwd 自身。
        result.skipped.push({ path: relativePath(root, path), kind: 'dir', reason: '符号链接未纳入文件检查点' })
        continue
      }
      if (stat.isDirectory()) {
        if (NEVER_ENTER_DIRS.has(name) || DERIVED_DIRS.has(name) || isBrowserProfileDir(path)) continue
        visit(path)
        continue
      }
      if (!stat.isFile()) continue // socket/FIFO 等无法快照，静默跳过
      if (SKIP_FILE_NAMES.has(name)) continue
      const rel = relativePath(root, path)
      if (stat.size > limits.maxFileBytes) {
        result.skipped.push({
          path: rel,
          kind: 'file',
          reason: `超过单文件快照上限（${formatBytes(stat.size)} > ${formatBytes(limits.maxFileBytes)}）`,
        })
        continue
      }
      if (result.bytes + stat.size > limits.maxTotalBytes) {
        result.partial = true
        return
      }
      result.bytes += stat.size
      result.files.push(rel)
    }
  }
}

function readManifest(path: string): CheckpointDescriptor {
  const manifestPath = join(path, MANIFEST_NAME)
  if (!existsSync(manifestPath)) throw new Error('Pi 文件检查点清单不存在，无法恢复')
  const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // v1 清单是纯路径数组（历史会话仍可直接回退）；v2 起带 skipped/partial/bytes
  if (Array.isArray(raw)) {
    return { engine: 'copy', files: validateManifestFiles(raw), skipped: [], partial: false, bytes: 0, repoBytes: 0 }
  }
  const manifest = raw as Partial<PiCheckpointManifestV2> | null
  if (!manifest) throw new Error('Pi 文件检查点清单无效')
  const files = validateManifestFiles(manifest.files)
  if (manifest.skipped !== undefined && (!Array.isArray(manifest.skipped) || !manifest.skipped.every(isSkipEntry))) {
    throw new Error('Pi 文件检查点清单包含无效跳过项')
  }
  return {
    engine: 'copy',
    files,
    skipped: manifest.skipped ?? [],
    partial: manifest.partial === true,
    bytes: typeof manifest.bytes === 'number' && Number.isFinite(manifest.bytes) && manifest.bytes > 0 ? manifest.bytes : 0,
    repoBytes: 0,
    ...(manifest.limits && typeof manifest.limits.maxFileBytes === 'number' && typeof manifest.limits.maxTotalBytes === 'number'
      ? { limits: { maxFileBytes: manifest.limits.maxFileBytes, maxTotalBytes: manifest.limits.maxTotalBytes } }
      : {}),
  }
}

/** 读取 v3（git）清单文件；非 git 清单返回 null。 */
function readGitManifest(manifestFile: string): CheckpointDescriptor | null {
  try {
    if (!existsSync(manifestFile) || !manifestFile.endsWith('.json')) return null
    const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<PiCheckpointManifestV3> | null
    if (!raw || raw.engine !== 'git' || typeof raw.treeSha !== 'string' || !isObjectId(raw.treeSha)) return null
    if (typeof raw.dir !== 'string' || typeof raw.cwd !== 'string' || typeof raw.ref !== 'string' || typeof raw.commitSha !== 'string' || !isCheckpointRef(raw.ref) || !isObjectId(raw.commitSha)) return null
    if (resolve(raw.dir) !== resolve(shadowRepoDirFor(dirname(manifestFile)))) return null
    const files = validateManifestFiles(raw.files)
    if (raw.skipped !== undefined && (!Array.isArray(raw.skipped) || !raw.skipped.every(isSkipEntry))) return null
    return {
      engine: 'git',
      files,
      skipped: raw.skipped ?? [],
      partial: raw.partial === true,
      bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
      repoBytes: typeof raw.repoBytes === 'number' ? raw.repoBytes : 0,
      ...(raw.limits && typeof raw.limits.maxFileBytes === 'number' && typeof raw.limits.maxTotalBytes === 'number'
        ? { limits: { maxFileBytes: raw.limits.maxFileBytes, maxTotalBytes: raw.limits.maxTotalBytes } }
        : {}),
      git: {
        dir: raw.dir,
        workTree: raw.cwd,
        treeSha: raw.treeSha,
        commitSha: raw.commitSha,
        ref: raw.ref,
        ...(raw.limits && typeof raw.limits.maxFileBytes === 'number' && typeof raw.limits.maxTotalBytes === 'number'
          ? { limits: { maxFileBytes: raw.limits.maxFileBytes, maxTotalBytes: raw.limits.maxTotalBytes } }
          : {}),
      },
    }
  } catch {
    return null
  }
}

/** 读取任意检查点条目（v3 清单文件、v2 目录、v1 数组目录）。 */
function readCheckpointEntry(entryPath: string): CheckpointDescriptor | null {
  if (entryPath.endsWith('.json')) return readGitManifest(entryPath)
  try {
    return readManifest(entryPath)
  } catch {
    return null
  }
}

function limitsFrom(options: PiCheckpointOptions): SnapshotLimits {
  return {
    maxFileBytes: options.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? MAX_SNAPSHOT_TOTAL_BYTES,
  }
}

/** 基线中「存在但未纳入」的内容：回退时必须保留，不得当作本轮新增删除。 */
function buildProtection(skipped: PiCheckpointSkip[]): {
  previous: Set<string>
  isProtected: (path: string) => boolean
} {
  const previous = new Set<string>()
  const roots: string[] = []
  for (const item of skipped) {
    if (item.kind === 'file') previous.add(item.path)
    roots.push(item.path)
  }
  const isProtected = (path: string): boolean => roots.some((root) =>
    root === '.' || path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`),
  )
  return { previous, isProtected }
}

function logSnapshotWarnings(skipped: PiCheckpointSkip[], partial: boolean, limits: SnapshotLimits): void {
  if (skipped.length > 0) {
    const preview = skipped.slice(0, 5).map((item) => `${item.path}(${item.reason})`).join(', ')
    console.warn(`[Pi 检查点] ${skipped.length} 项内容未纳入基线，回退时不会被删除: ${preview}`)
  }
  if (partial) {
    console.warn(`[Pi 检查点] 基线不完整（超过 ${formatBytes(limits.maxTotalBytes)}），回退时将只恢复、不删除失败期间的产物`)
  }
}

function buildGitFailureSkips(paths: string[], reason: string): PiCheckpointSkip[] {
  return paths
    .map(fromGitPath)
    .filter((path) => isSafeCheckpointPath(path))
    .map((path) => ({ path, kind: 'file' as const, reason }))
}

function checkpointIdentity(input: {
  treeSha: string
  skipped: PiCheckpointSkip[]
  partial: boolean
  limits: SnapshotLimits
}): string {
  const skipped = input.skipped
    .map((item) => `${item.kind}\u0000${item.path}\u0000${item.reason}`)
    .sort()
  return JSON.stringify({
    treeSha: input.treeSha,
    skipped,
    partial: input.partial,
    limits: input.limits,
  })
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value), 'utf8')
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true, maxRetries: 3, retryDelay: 50 })
  }
}

/** 会话目录里最新的 git 检查点（id 以时间戳开头，字典序即时间序）。 */
function findLatestGitCheckpoint(sessionDir: string): { path: string; descriptor: CheckpointDescriptor } | null {
  let names: string[]
  try {
    names = readdirSync(sessionDir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return null
  }
  const latest = names[names.length - 1]
  if (!latest) return null
  const path = join(sessionDir, latest)
  const descriptor = readGitManifest(path)
  return descriptor ? { path, descriptor } : null
}

interface GitCreateOutcome {
  checkpoint?: PiFileCheckpoint
  reason?: string
}

/**
 * git 引擎：影子仓库 tree 快照 + 检查点 ref。
 *
 * 失败一律返回 reason 而不抛异常（受控降级）；只有显式 `mode: 'git'` 时才由调用方转成错误。
 */
function tryCreateGitCheckpoint(params: {
  sessionDir: string
  cwd: string
  id: string
  walked: WalkResult
  limits: SnapshotLimits
}): GitCreateOutcome {
  if (!isGitSnapshotAvailable()) return { reason: '未检测到可用的 git' }
  const repo = { dir: shadowRepoDirFor(params.sessionDir), workTree: params.cwd }
  try {
    if (!ensureShadowRepo(repo)) return { reason: '影子仓库初始化失败' }
    const gitPaths = params.walked.files.map(toGitPath)
    const snapshot = snapshotPaths(repo, gitPaths)
    if (!snapshot.ok) return { reason: snapshot.error ?? '生成 tree 失败' }

    const skipped = mergeSkipped(
      params.walked.skipped,
      buildGitFailureSkips(snapshot.failures, '写入 git 对象失败（可能被占用）'),
    )
    const successfulGitPaths = gitPaths.filter((path) => !snapshot.failures.includes(path))

    // Tree 相同不代表恢复语义相同：partial、skipped 和 limits 都决定是否允许删除。
    // 只有完整语义身份相同时才能复用上一份基线。
    const identity = checkpointIdentity({ treeSha: snapshot.treeSha, skipped, partial: params.walked.partial, limits: params.limits })
    const latest = findLatestGitCheckpoint(params.sessionDir)
    if (latest?.descriptor.engine === 'git' && latest.descriptor.git
      && checkpointIdentity({
        treeSha: latest.descriptor.git.treeSha,
        skipped: latest.descriptor.skipped,
        partial: latest.descriptor.partial,
        limits: latest.descriptor.limits ?? params.limits,
      }) === identity) {
      return {
        checkpoint: {
          path: latest.path,
          engine: 'git',
          files: latest.descriptor.files,
          skipped: latest.descriptor.skipped,
          partial: latest.descriptor.partial,
          limits: latest.descriptor.limits,
          git: latest.descriptor.git,
        },
      }
    }

    const ref = checkpointRef(params.id)
    const commit = commitTree(repo, snapshot.treeSha, [
      `profer-pi-checkpoint ${params.id}`,
      `cwd ${params.cwd}`,
      `files ${gitPaths.length}`,
    ].join('\n'))
    if (!commit.ok || !commit.commitSha) return { reason: '创建提交对象失败' }
    if (!updateRef(repo, ref, commit.commitSha)) return { reason: '写入检查点 ref 失败' }

    const manifest: PiCheckpointManifestV3 = {
      version: 3,
      engine: 'git',
      treeSha: snapshot.treeSha,
      commitSha: commit.commitSha,
      ref,
      dir: repo.dir,
      cwd: params.cwd,
      files: successfulGitPaths,
      skipped,
      partial: params.walked.partial,
      bytes: params.walked.bytes,
      repoBytes: countRepoBytes(repo),
      createdAt: Date.now(),
      limits: { ...params.limits },
    }
    const path = join(params.sessionDir, `${params.id}.json`)
    try {
      writeJsonAtomic(path, manifest)
    } catch (error) {
      const refRemoved = deleteRef(repo, ref)
      if (refRemoved) gcShadowRepo(repo)
      return { reason: `写入检查点清单失败: ${describeError(error)}` }
    }
    logSnapshotWarnings(skipped, manifest.partial, params.limits)
    return {
      checkpoint: {
        path,
        engine: 'git',
        files: successfulGitPaths,
        skipped,
        partial: manifest.partial,
        limits: { ...params.limits },
        git: {
          dir: repo.dir,
          workTree: params.cwd,
          treeSha: manifest.treeSha,
          commitSha: manifest.commitSha,
          ref,
          limits: { ...params.limits },
        },
      },
    }
  } catch (error) {
    return { reason: describeError(error) }
  }
}

/** 全量复制引擎：git 不可用或工作区无法保证逐字节时的降级路径。 */
function createCopyCheckpoint(params: {
  cwd: string
  rootDir: string
  sessionId: string
  walked: WalkResult
  limits: SnapshotLimits
}): PiFileCheckpoint {
  const path = join(
    params.rootDir,
    params.sessionId,
    String(Date.now()) + '-' + Math.random().toString(36).slice(2),
  )
  mkdirSync(path, { recursive: true })

  const files: string[] = []
  const skipped = [...params.walked.skipped]
  for (const file of params.walked.files) {
    const copy = copyFileResilient(join(params.cwd, file), join(path, file))
    if (copy.ok) files.push(file)
    else skipped.push({ path: file, kind: 'file', reason: copy.reason })
  }

  const manifest: PiCheckpointManifestV2 = {
    version: 2,
    files,
    skipped,
    partial: params.walked.partial,
    bytes: params.walked.bytes,
    limits: { ...params.limits },
  }
  try {
    writeJsonAtomic(join(path, MANIFEST_NAME), manifest)
  } catch (error) {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    throw new Error(`写入复制检查点清单失败: ${describeError(error)}`)
  }
  logSnapshotWarnings(skipped, params.walked.partial, params.limits)
  return { path, engine: 'copy', files, skipped, partial: params.walked.partial, limits: { ...params.limits } }
}

export function createPiFileCheckpoint(
  sessionId: string,
  cwd: string,
  rootDir: string,
  options: PiCheckpointOptions = {},
): PiFileCheckpoint {
  const limits = limitsFrom(options)
  const mode: PiCheckpointMode = options.mode ?? 'auto'
  const sessionDir = join(rootDir, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const walked = walk(cwd, limits)

  if (mode !== 'copy') {
    if (walked.rewriteRisk) {
      console.warn('[Pi 检查点] 工作区存在会改写内容的 .gitattributes，改用全量复制以保证逐字节还原')
    } else {
      const git = tryCreateGitCheckpoint({ sessionDir, cwd, id, walked, limits })
      if (git.checkpoint) return git.checkpoint
      const reason = git.reason ?? '未知原因'
      if (mode === 'git') throw new Error(`Pi 检查点 git 引擎不可用: ${reason}`)
      console.warn(`[Pi 检查点] git 引擎不可用（${reason}），降级为全量复制`)
    }
  }

  return createCopyCheckpoint({ cwd, rootDir, sessionId, walked, limits })
}

export function loadPiFileCheckpoint(path: string): PiFileCheckpoint {
  if (path.endsWith('.json')) {
    const descriptor = readGitManifest(path)
    if (!descriptor || !descriptor.git) throw new Error('Pi 文件检查点清单无效')
    return {
      path,
      engine: 'git',
      files: descriptor.files,
      skipped: descriptor.skipped,
      partial: descriptor.partial,
      limits: descriptor.limits,
      git: descriptor.git,
    }
  }
  const manifest = readManifest(path)
  return {
    path,
    engine: 'copy',
    files: manifest.files,
    skipped: manifest.skipped,
    partial: manifest.partial,
    limits: manifest.limits,
  }
}

export function restorePiFileCheckpoint(checkpoint: PiFileCheckpoint, cwd: string): PiRestoreResult {
  if (!existsSync(checkpoint.path)) throw new Error('Pi 文件检查点不存在，无法恢复')
  return checkpoint.engine === 'git' && checkpoint.git
    ? restoreGitCheckpoint(checkpoint, cwd)
    : restoreCopyCheckpoint(checkpoint, cwd)
}

/**
 * git 引擎回退：先快照当前状态，与基线 tree 对比，新增的删除、改动/删除的从基线还原。
 *
 * 树里都是相对路径，所以传进来的 cwd 可以与快照时的 cwd 不同（分叉会话沿用源基线时依然成立）。
 */
function restoreGitCheckpoint(checkpoint: PiFileCheckpoint, cwd: string): PiRestoreResult {
  const git = checkpoint.git
  if (!git) throw new Error('Pi 文件检查点缺少 git 基线信息，无法恢复')
  const repo = { dir: git.dir, workTree: cwd }
  // 沿用快照时的体积规则：否则基线排除的超大文件会在当前状态里出现，被误判为本轮新增
  const limits: SnapshotLimits = checkpoint.limits ?? git.limits ?? {
    maxFileBytes: MAX_SNAPSHOT_FILE_BYTES,
    maxTotalBytes: MAX_SNAPSHOT_TOTAL_BYTES,
  }
  const current = walk(cwd, limits)
  const skipped = mergeSkipped(checkpoint.skipped, current.skipped)
  const changed: string[] = []
  const snapshot = snapshotPaths(repo, current.files.map(toGitPath))
  if (!snapshot.ok) {
    const result = {
      changed,
      skipped: mergeSkipped(skipped, [{ path: '.', kind: 'dir' as const, reason: snapshot.error ?? '快照当前工作区失败，无法安全回退' }]),
      incomplete: true,
      failed: true,
    }
    logRestoreWarnings(result.skipped)
    return result
  }

  const diffResult = diffTrees(repo, git.treeSha, snapshot.treeSha)
  if (!diffResult.ok) {
    const result = {
      changed,
      skipped: mergeSkipped(skipped, [{ path: '.', kind: 'dir' as const, reason: diffResult.error ?? '比较检查点 tree 失败，无法安全回退' }]),
      incomplete: true,
      failed: true,
    }
    logRestoreWarnings(result.skipped)
    return result
  }

  const protection = buildProtection(checkpoint.skipped)
  const existedAtBaseline = (path: string): boolean => protection.previous.has(path) || protection.isProtected(path)
  const diff = diffResult.diff

  if (!checkpoint.partial) {
    for (const path of diff.added) {
      if (existedAtBaseline(path)) {
        skipped.push({ path, kind: 'file', reason: '基线中已存在但未能快照，保留不删' })
        continue
      }
      try {
        removeWorkspaceFile(cwd, path)
        changed.push(path)
      } catch (error) {
        skipped.push({ path, kind: 'file', reason: describeError(error) })
      }
    }
  }

  const restoreTargets = [...new Set([...diff.modified, ...diff.deleted])]
  const readyTargets: string[] = []
  for (const path of restoreTargets) {
    try {
      prepareRestoreFileTarget(cwd, path)
      readyTargets.push(path)
    } catch (error) {
      skipped.push({ path, kind: 'file', reason: describeError(error) })
    }
  }
  if (readyTargets.length > 0) {
    const failed = new Set(restorePathsFromTree(repo, git.treeSha, readyTargets.map(toGitPath)).map(fromGitPath))
    for (const path of readyTargets) {
      if (failed.has(path)) skipped.push({ path, kind: 'file', reason: '从基线还原失败（可能被占用）' })
      else changed.push(path)
    }
  }

  const result = {
    changed: [...new Set(changed)],
    skipped: mergeSkipped(skipped),
    incomplete: checkpoint.partial || checkpoint.skipped.length > 0 || current.partial || current.skipped.length > 0 || skipped.length > 0,
  }
  logRestoreWarnings(result.skipped)
  return result
}

function logRestoreWarnings(skipped: PiCheckpointSkip[]): void {
  if (skipped.length === 0) return
  const preview = skipped.slice(0, 5).map((item) => `${item.path}(${item.reason})`).join(', ')
  console.warn(`[Pi 检查点] ${skipped.length} 项未能完整恢复: ${preview}`)
}

/** 全量复制引擎回退（v1/v2 基线，以及 git 不可用时的降级基线）。 */
function restoreCopyCheckpoint(checkpoint: PiFileCheckpoint, cwd: string): PiRestoreResult {
  const protection = buildProtection(checkpoint.skipped)
  const previous = new Set([...checkpoint.files, ...protection.previous])
  const isProtected = (file: string): boolean => previous.has(file) || protection.isProtected(file)
  const limits = checkpoint.limits ?? {
    maxFileBytes: MAX_SNAPSHOT_FILE_BYTES,
    maxTotalBytes: MAX_SNAPSHOT_TOTAL_BYTES,
  }
  const current = walk(cwd, limits)

  const changed: string[] = []
  const skipped = mergeSkipped(checkpoint.skipped, current.skipped)
  if (!checkpoint.partial) {
    for (const file of current.files) {
      if (isProtected(file)) continue
      try {
        removeWorkspaceFile(cwd, file)
        changed.push(file)
      } catch (error) {
        skipped.push({ path: file, kind: 'file', reason: describeError(error) })
      }
    }
  }

  for (const file of checkpoint.files) {
    const copy = restoreCopyFile(checkpoint.path, cwd, file)
    if (copy.ok) changed.push(file)
    else skipped.push({ path: file, kind: 'file', reason: copy.reason })
  }

  const result = {
    changed: [...new Set(changed)],
    skipped: mergeSkipped(skipped),
    incomplete: checkpoint.partial || checkpoint.skipped.length > 0 || current.partial || current.skipped.length > 0 || skipped.length > 0,
  }
  logRestoreWarnings(result.skipped)
  return result
}

export function removePiFileCheckpoints(rootDir: string, sessionId: string): void {
  const path = join(rootDir, sessionId)
  if (!existsSync(path)) return
  try {
    // 影子仓库里的对象文件在 Windows 上可能是只读属性，放宽重试
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch (error) {
    console.warn(`[Pi 检查点] 删除检查点目录失败 ${path}: ${describeError(error)}`)
  }
}

/**
 * 异步版检查点目录清理。
 *
 * 单个会话的检查点目录可能包含十几万个文件（本机最大 2.4GB / 15 万文件），
 * 同步 rmSync 会把主进程事件循环按住数秒。删除会话改走这里。
 */
export async function removePiFileCheckpointsAsync(rootDir: string, sessionId: string): Promise<void> {
  const path = join(rootDir, sessionId)
  if (!existsSync(path)) return
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch (error) {
    console.warn(`[Pi 检查点] 删除检查点目录失败 ${path}: ${describeError(error)}`)
  }
}

export interface PiCheckpointAdoptionResult {
  /** 旧路径 → 目标会话目录里的新路径 */
  adopted: Record<string, string>
  /** 未能迁移的旧路径（调用方保留原引用或明确降级） */
  failed: string[]
}

/**
 * 递归搬迁一个基线目录，返回失败的文件数（>0 表示目标不完整，调用方应丢弃并降级）。
 *
 * 优先硬链接：基线目录创建后不再被修改，同卷硬链接既零额外占盘也完全安全；
 * 不支持硬链接的环境（跨卷/特殊文件系统）自动退回带重试的容错复制。
 */
function copyCheckpointDir(sourceDir: string, targetDir: string): number {
  let failures = 0
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch {
    return 1
  }
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isSymbolicLink()) {
      failures += 1
      continue
    }
    if (entry.isDirectory()) {
      failures += copyCheckpointDir(source, target)
      continue
    }
    if (!entry.isFile()) {
      failures += 1
      continue
    }
    try {
      linkSync(source, target)
      continue
    } catch {
      /* 回退到容错复制 */
    }
    if (!copyFileResilient(source, target).ok) failures += 1
  }
  return failures
}

/**
 * 把检查点迁移到另一个会话目录下，使目标会话自包含。
 *
 * 分叉会话会继承分叉点之前各 turn 的基线，而那些基线存放在源会话目录里。
 * 若直接引用：源会话的常规回收或删除就会静默搞掉分叉侧的回退点。
 * 因此分叉时把用到的基线整体搬过来（git 条目通过本地 fetch 仅导入该 ref 可达对象），
 * 从而保持一条硬不变式：**会话的 piFileCheckpoints 永远只指向自己的检查点目录**。
 */
export function adoptPiFileCheckpoints(params: {
  rootDir: string
  targetSessionId: string
  paths: Iterable<string>
}): PiCheckpointAdoptionResult {
  const adopted: Record<string, string> = {}
  const failed: string[] = []
  const targetSessionDir = join(params.rootDir, params.targetSessionId)

  for (const sourcePath of params.paths) {
    try {
      if (!existsSync(sourcePath)) {
        failed.push(sourcePath)
        continue
      }
      mkdirSync(targetSessionDir, { recursive: true })
      const targetPath = join(targetSessionDir, basename(sourcePath))
      if (existsSync(targetPath)) {
        adopted[sourcePath] = targetPath
        continue
      }

      // 复制引擎的条目是目录（内部自带清单），原样搬到目标目录即可，没有仓库内指向需要重写
      if (!sourcePath.endsWith('.json')) {
        const copied = copyCheckpointDir(sourcePath, targetPath)
        if (copied > 0) {
          rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
          failed.push(sourcePath)
          continue
        }
        adopted[sourcePath] = targetPath
        continue
      }

      const manifest = readGitManifest(sourcePath)
      const git = manifest?.git
      if (!manifest || !git) {
        failed.push(sourcePath)
        continue
      }
      const targetRepo = { dir: shadowRepoDirFor(targetSessionDir), workTree: git.workTree }
      if (!ensureShadowRepo(targetRepo)) {
        failed.push(sourcePath)
        continue
      }
      const imported = importRefFromRepo({
        targetRepo,
        sourceRepoDir: git.dir,
        ref: git.ref,
        commitSha: git.commitSha,
      })
      if (!imported) {
        failed.push(sourcePath)
        continue
      }
      const raw = JSON.parse(readFileSync(sourcePath, 'utf8')) as PiCheckpointManifestV3
      writeJsonAtomic(targetPath, { ...raw, dir: targetRepo.dir })
      adopted[sourcePath] = targetPath
    } catch (error) {
      console.warn(`[Pi 检查点] 迁移检查点失败 ${sourcePath}: ${describeError(error)}`)
      failed.push(sourcePath)
    }
  }

  if (failed.length > 0) {
    console.warn(`[Pi 检查点] ${failed.length} 份基线未能迁移到会话 ${params.targetSessionId}，将保留原引用`)
  }
  return { adopted, failed }
}

export interface PiPruneResult {
  /** 被回收的检查点条目；调用方应据此从 piFileCheckpoints 映射中摘除对应绑定 */
  removed: string[]
  /** 其中仍被回退点引用、却因超出上限而被回收的数量 */
  removedBound: number
  /** 是否顺带释放了整个影子仓库（没有检查点残留时） */
  releasedRepo: boolean
}

/**
 * 回收单个会话的检查点：每轮一份基线，不回收会把用户磁盘吃满。
 *
 * - 未被任何回退点引用的条目直接删除（git 条目先删 ref，使对象可被 gc）
 * - 被引用的条目超过数量/体积上限时从最旧开始删除，并由调用方同步丢弃绑定，
 *   使磁盘内容与 piFileCheckpoints 映射始终一致（被删的回退点会明确降级提示，而不是静默失效）
 * - 没有检查点残留时直接删除整个影子仓库，一次性释放全部对象
 */
export function prunePiFileCheckpoints(
  rootDir: string,
  sessionId: string,
  options: { keepPaths?: Iterable<string>; maxCount?: number; maxBytes?: number } = {},
): PiPruneResult {
  const sessionDir = join(rootDir, sessionId)
  if (!existsSync(sessionDir)) return { removed: [], removedBound: 0, releasedRepo: false }

  const keep = new Set(options.keepPaths ?? [])
  const maxCount = options.maxCount ?? MAX_CHECKPOINTS_PER_SESSION
  const maxBytes = options.maxBytes ?? MAX_CHECKPOINT_BYTES_PER_SESSION
  const repo = { dir: shadowRepoDirFor(sessionDir), workTree: sessionDir }
  let gitRemoved = false

  const removed: string[] = []
  const removeEntry = (patch: string, descriptor: CheckpointDescriptor | null): boolean => {
    try {
      // 先删 manifest，再删 ref。文件删除失败时仍保留 ref，避免留下一个“可见但无法恢复”的基线。
      rmSync(patch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      if (descriptor?.engine === 'git' && descriptor.git?.ref) {
        if (!deleteRef(repo, descriptor.git.ref)) {
          console.warn(`[Pi 检查点] 已删除清单但未能删除 ref: ${descriptor.git.ref}`)
        } else {
          gitRemoved = true
        }
      }
      removed.push(patch)
      return true
    } catch (error) {
      console.warn(`[Pi 检查点] 回收失败 ${patch}: ${describeError(error)}`)
      return false
    }
  }

  interface Entry {
    path: string
    descriptor: CheckpointDescriptor | null
    mtime: number
    bound: boolean
  }
  const entries: Entry[] = []

  for (const name of readdirSync(sessionDir)) {
    if (isShadowRepoDirName(name)) continue
    const path = join(sessionDir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    const isStale = (): boolean => Date.now() - stat.mtimeMs > ORPHAN_CHECKPOINT_TTL_MS
    if (stat.isDirectory()) {
      // 崩溃/中断留下的半成品目录（无清单即无法回退），过了保鲜期直接回收
      if (!existsSync(join(path, MANIFEST_NAME))) {
        if (isStale()) removeEntry(path, null)
        continue
      }
      entries.push({ path, descriptor: readCheckpointEntry(path), mtime: stat.mtimeMs, bound: keep.has(path) })
      continue
    }
    if (!name.endsWith('.json')) continue
    const descriptor = readGitManifest(path)
    if (!descriptor) {
      if (isStale()) removeEntry(path, null)
      continue
    }
    entries.push({ path, descriptor, mtime: stat.mtimeMs, bound: keep.has(path) })
  }

  for (const entry of entries) if (!entry.bound) removeEntry(entry.path, entry.descriptor)

  const survivors = entries
    .filter((entry) => entry.bound && existsSync(entry.path))
    .sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))
  const estimateBytes = (): number => {
    let copyBytes = 0
    let repoBytes = 0
    for (const entry of survivors) {
      if (entry.descriptor?.engine === 'copy') copyBytes += entry.descriptor.bytes
      else repoBytes = Math.max(repoBytes, entry.descriptor?.repoBytes ?? 0)
    }
    return copyBytes + repoBytes
  }

  let removedBound = 0
  while (survivors.length > maxCount || (survivors.length > 1 && estimateBytes() > maxBytes)) {
    const victim = survivors.shift()
    if (!victim) break
    if (removeEntry(victim.path, victim.descriptor)) removedBound += 1
    else {
      survivors.unshift(victim)
      break
    }
  }

  // 清理“ref 已写入、manifest 尚未来得及原子落盘”时的崩溃残留，避免对象永久占盘。
  // 只将仍在磁盘上的 manifest 视为 ref 的有效所有者；删除失败的条目仍会保留它的 ref。
  const remainingEntries = entries.filter((entry) => existsSync(entry.path))
  const referencedRefs = new Set(
    remainingEntries.flatMap((entry) => entry.descriptor?.engine === 'git' && entry.descriptor.git?.ref ? [entry.descriptor.git.ref] : []),
  )
  for (const ref of listCheckpointRefs(repo)) {
    if (referencedRefs.has(ref)) continue
    if (deleteRef(repo, ref)) gitRemoved = true
  }

  const hasGitSurvivor = remainingEntries.some((entry) => entry.descriptor?.engine === 'git')
  let releasedRepo = false
  if (!hasGitSurvivor && existsSync(shadowRepoDirFor(sessionDir))) {
    // 无论是显式删 ref、git 降级到 copy，还是初始化/写清单中断留下的空仓库，都不能无限残留。
    removeShadowRepo(sessionDir)
    releasedRepo = true
  } else if (gitRemoved) {
    gcShadowRepo(repo)
  }

  if (removed.length > 0) {
    console.log(
      `[Pi 检查点] 回收 ${removed.length} 份快照（session=${sessionId}，其中 ${removedBound} 份同步丢弃了回退绑定${releasedRepo ? '，已释放影子仓库' : ''}）`,
    )
  }
  return { removed, removedBound, releasedRepo }
}
