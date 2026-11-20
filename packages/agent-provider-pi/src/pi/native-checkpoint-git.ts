import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
function findGitPath(): string | null {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (result.status !== 0) return null
  return result.stdout.trim().split(/\r?\n/)[0] || null
}

/**
 * Pi 检查点的纯 git 层：影子仓库 + tree 对象快照。
 *
 * 设计取向（融合社区成熟做法）：
 * - 每个会话一个私有 **bare 影子仓库**，`--work-tree` 指向会话 cwd，
 *   因此工作区不是 git 仓库也能用，且绝不碰用户自己的仓库/索引
 * - 快照 = 「空排除项下按显式路径 add → write-tree → commit-tree → 一个检查点 ref」，
 *   tree 之间的 diff 天然给出「本轮新增/修改/删除」，diff SHA 天然做 dedup
 * - 只存增量对象：改动 1 个文件时开销 O(改动)，而不是 O(cwd)
 * - 每个检查点一个 ref（不做父子链），删 ref 即可让 git 回收对象，
 *   避免「父提交把已删除检查点的对象钉住」
 *
 * 本层刻意不依赖 Pi / Profer 业务类型，便于独立测试。
 */

/** 首次快照可能要哈希整个目录，超时给足；实际增量快照在几十毫秒级 */
const GIT_TIMEOUT_MS = 120_000
const GIT_GC_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024
/** 老版本 git 不支持 --pathspec-from-file 时，退回按批传参（Windows 命令行长度有限制） */
const ADD_BATCH_SIZE = 100
const SHADOW_REPO_DIR_NAME = 'shadow.git'
const REF_PREFIX = 'refs/profer/checkpoints/'
/** 未配置 git 身份的机器上 commit-tree 会失败，显式给一个本地身份 */
const COMMIT_IDENTITY = ['-c', 'user.name=Profer', '-c', 'user.email=profer@localhost']

let cachedGitPath: string | null | undefined
let gitPathOverride: { value: string | null } | undefined

/** 测试钩子：覆盖 git 可执行路径解析结果 */
export function __setGitExecutableForTest(value: string | null | undefined): void {
  gitPathOverride = value === undefined ? undefined : { value }
}

export function resolveGitExecutable(): string | null {
  if (gitPathOverride) return gitPathOverride.value
  if (cachedGitPath === undefined) cachedGitPath = findGitPath()
  return cachedGitPath
}

export function isGitSnapshotAvailable(): boolean {
  return resolveGitExecutable() !== null
}

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

interface GitRunOptions {
  gitDir?: string
  workTree?: string
  timeoutMs?: number
  /** 需要写入子进程 stdin 的内容（paths 走 stdin 可避开命令行长度与转义问题） */
  input?: string
}

function runGit(args: string[], options: GitRunOptions = {}): GitCommandResult {
  const gitPath = resolveGitExecutable()
  if (!gitPath) return { ok: false, stdout: '', stderr: 'git executable not found' }
  const fullArgs: string[] = []
  if (options.gitDir) fullArgs.push('--git-dir', options.gitDir)
  if (options.workTree) fullArgs.push('--work-tree', options.workTree)
  fullArgs.push(...args)
  // 工作区可能已被删除（会话目录清理中），此时仍需能执行 update-ref / gc 等仓库级操作
  const cwd = options.workTree && existsSync(options.workTree) ? options.workTree : process.cwd()
  const result = spawnSync(gitPath, fullArgs, {
    cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    ...(options.input === undefined ? {} : { input: options.input }),
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error) return { ok: false, stdout, stderr: stderr || result.error.message }
  return { ok: result.status === 0, stdout, stderr }
}

export interface ShadowRepo {
  /** 影子仓库（bare）目录 */
  dir: string
  /** 工作区根目录（会话 cwd） */
  workTree: string
}

export function shadowRepoDirFor(sessionDir: string): string {
  return join(sessionDir, SHADOW_REPO_DIR_NAME)
}

export function isShadowRepoDirName(name: string): boolean {
  return name === SHADOW_REPO_DIR_NAME
}

/**
 * 确保影子仓库存在并写好固定配置。
 *
 * - `core.excludesfile` 指向空文件、`gc.auto=0`：排除规则完全由调用方给出，
 *   不让用户全局 gitignore 或后台 gc 影响检查点语义
 * - `core.autocrlf=false`：避免换行转换破坏「逐字节还原」的期望
 */
export function ensureShadowRepo(repo: ShadowRepo): boolean {
  if (!existsSync(join(repo.dir, 'HEAD'))) {
    try {
      mkdirSync(repo.dir, { recursive: true })
    } catch {
      return false
    }
    const gitPath = resolveGitExecutable()
    if (!gitPath) return false
    const init = spawnSync(gitPath, ['init', '--bare', '--quiet', repo.dir], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    if (init.status !== 0) return false
  }

  const bare = runGit(['rev-parse', '--is-bare-repository'], { gitDir: repo.dir })
  if (!bare.ok || bare.stdout.trim() !== 'true') return false

  const emptyExcludes = join(repo.dir, 'empty-excludes')
  try {
    writeFileSync(emptyExcludes, '', 'utf8')
  } catch {
    return false
  }
  const config: Array<[string, string]> = [
    ['core.excludesfile', emptyExcludes],
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['gc.auto', '0'],
    ['core.longpaths', 'true'],
  ]
  return config.every(([key, value]) => runGit(['config', key, value], { gitDir: repo.dir, workTree: repo.workTree }).ok)
}

/**
 * 把另一个影子仓库的某个检查点迁移到本仓库：复制对象（优先硬链接，同卷不占额外字节）
 * 并写入同名 ref，使目标仓库自包含。
 *
 * 用于分叉会话：分叉后两边可以各自独立回收，不存在"删了别人的回退点"的跨会话耦合。
 * 迁移后会用 `cat-file -t` 验证对象真的可用，避免"看着成功、回退时才发现缺对象"。
 */
export function importRefFromRepo(params: {
  targetRepo: ShadowRepo
  sourceRepoDir: string
  ref: string
  commitSha: string
}): boolean {
  const { targetRepo, sourceRepoDir, ref, commitSha } = params
  if (!isCheckpointRef(ref) || !isObjectId(commitSha) || !existsSync(sourceRepoDir)) return false

  // Local fetch imports only the requested ref and its reachable objects. Copying the full
  // objects directory pulled unrelated later checkpoints into every fork.
  const fetched = runGit(['fetch', '--no-tags', '--quiet', sourceRepoDir, `${ref}:${ref}`], {
    gitDir: targetRepo.dir,
    workTree: targetRepo.workTree,
  })
  if (!fetched.ok) return false

  const verify = runGit(['cat-file', '-t', commitSha], { gitDir: targetRepo.dir, workTree: targetRepo.workTree })
  if (!verify.ok || verify.stdout.trim() !== 'commit') return false
  const targetRef = runGit(['rev-parse', '--verify', ref], { gitDir: targetRepo.dir, workTree: targetRepo.workTree })
  return targetRef.ok && targetRef.stdout.trim() === commitSha
}

/**
 * 删除影子仓库。目录名固定，因此只需给出会话目录。
 */
export function removeShadowRepo(sessionDir: string): void {
  const dir = shadowRepoDirFor(sessionDir)
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* 残留对象不影响正确性，交给会话目录清理重试 */
  }
}

const pathSeparatorPattern = /\\/g

/** git 统一使用正斜杠路径；Windows 下必须转换后再传给 pathspec */
export function toGitPath(relativePath: string): string {
  return relativePath.replace(pathSeparatorPattern, '/')
}

export function fromGitPath(gitPath: string): string {
  return process.platform === 'win32' ? gitPath.replace(/\//g, '\\') : gitPath
}

function listIndexPaths(repo: ShadowRepo): string[] {
  const result = runGit(['ls-files', '-z'], { gitDir: repo.dir, workTree: repo.workTree })
  if (!result.ok) return []
  return result.stdout.split('\0').filter((entry) => entry.length > 0)
}

export interface SnapshotResult {
  ok: boolean
  treeSha: string
  /** 因占用/权限无法写入对象库的路径（回退时必须保护，不得删除） */
  failures: string[]
  error?: string
}

/**
 * 用显式路径列表生成工作区 tree。
 *
 * 索引是持久的（保留 stat 缓存 → 未改动文件不重复哈希），因此需要显式处理「消失的文件」：
 * 索引里存在、本次枚举里不存在的路径会被 `update-index --force-remove` 清掉，
 * 否则旧条目会残留在 tree 里，让回退误判历史状态。
 */
/** path 以 NUL 分隔喂给 git stdin；路径含空格/中文/引号时依然安全 */
function nulSeparated(paths: string[]): string {
  return paths.length === 0 ? '' : `${paths.join('\u0000')}\u0000`
}

/** 首次探测后记忆：老版本 git（<2.25）没有 --pathspec-from-file */
let pathspecFromFileSupported: boolean | undefined

/** 把工作区已消失的文件从索引摘掉（保留其余条目的 stat 缓存，增量快照才够快） */
function dropStaleIndexEntries(repo: ShadowRepo, stale: string[]): string[] {
  if (stale.length === 0) return []
  const viaStdin = runGit(['update-index', '--force-remove', '-z', '--stdin'], {
    gitDir: repo.dir,
    workTree: repo.workTree,
    input: nulSeparated(stale),
  })
  if (viaStdin.ok) return []

  const failed: string[] = []
  for (let i = 0; i < stale.length; i += ADD_BATCH_SIZE) {
    const batch = stale.slice(i, i + ADD_BATCH_SIZE)
    if (runGit(['update-index', '--force-remove', '--', ...batch], {
      gitDir: repo.dir,
      workTree: repo.workTree,
    }).ok) continue
    for (const path of batch) {
      if (!runGit(['update-index', '--force-remove', '--', path], {
        gitDir: repo.dir,
        workTree: repo.workTree,
      }).ok) failed.push(path)
    }
  }
  return failed
}

/** 返回未能纳入基线的路径（被占用/权限不足等） */
function addPathsToIndex(repo: ShadowRepo, gitPaths: string[]): string[] {
  if (gitPaths.length === 0) return []
  const options = { gitDir: repo.dir, workTree: repo.workTree }
  if (pathspecFromFileSupported !== false) {
    // 一次进程调用即可处理任意数量路径，避免每批 100 个路径就付一次进程启动开销
    const viaStdin = runGit(['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...options,
      input: nulSeparated(gitPaths),
    })
    if (viaStdin.ok) {
      pathspecFromFileSupported = true
      return []
    }
    if (/unknown option|usage:|pathspec-from-file/i.test(viaStdin.stderr)) pathspecFromFileSupported = false
  }

  const failures: string[] = []
  for (let i = 0; i < gitPaths.length; i += ADD_BATCH_SIZE) {
    const batch = gitPaths.slice(i, i + ADD_BATCH_SIZE)
    // -f：绕过工作区 .gitignore，排除规则完全由调用方决定（避免 .gitignore 变化造成基线不对称）
    const result = runGit(['add', '--force', '--', ...batch], options)
    if (result.ok) continue
    // 批量失败通常是被占用/权限导致，逐文件重试以精确定位受害者
    for (const path of batch) {
      const single = runGit(['add', '--force', '--', path], options)
      if (!single.ok) failures.push(path)
    }
  }
  return failures
}

export function snapshotPaths(repo: ShadowRepo, gitPaths: string[]): SnapshotResult {
  const wanted = new Set(gitPaths)
  const staleFailures = dropStaleIndexEntries(repo, listIndexPaths(repo).filter((entry) => !wanted.has(entry)))
  if (staleFailures.length > 0) {
    return { ok: false, treeSha: '', failures: [], error: `无法从 git 索引移除 ${staleFailures.length} 个过期路径` }
  }

  const failures = addPathsToIndex(repo, gitPaths)
  const cleanupFailures = dropStaleIndexEntries(repo, failures)
  if (cleanupFailures.length > 0) {
    return { ok: false, treeSha: '', failures, error: `无法从 git 索引移除 ${cleanupFailures.length} 个未快照路径` }
  }

  const writeTree = runGit(['write-tree'], { gitDir: repo.dir, workTree: repo.workTree })
  if (!writeTree.ok) {
    return { ok: false, treeSha: '', failures, error: writeTree.stderr.trim() || 'git write-tree 失败' }
  }
  return { ok: true, treeSha: writeTree.stdout.trim(), failures }
}

export function commitTree(repo: ShadowRepo, treeSha: string, message: string): { ok: boolean; commitSha: string } {
  const result = runGit([...COMMIT_IDENTITY, 'commit-tree', treeSha, '-m', message], {
    gitDir: repo.dir,
    workTree: repo.workTree,
  })
  return { ok: result.ok, commitSha: result.stdout.trim() }
}

export function checkpointRef(id: string): string {
  return `${REF_PREFIX}${id}`
}

export function isCheckpointRef(ref: string): boolean {
  return ref.startsWith(REF_PREFIX)
    && ref.length > REF_PREFIX.length
    && !ref.includes('..')
    && !/[~^:\\?*\[\s]/.test(ref)
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)
}

export function updateRef(repo: ShadowRepo, ref: string, commitSha: string): boolean {
  return runGit(['update-ref', ref, commitSha], { gitDir: repo.dir, workTree: repo.workTree }).ok
}

export function deleteRef(repo: ShadowRepo, ref: string): boolean {
  if (!isCheckpointRef(ref)) return false
  return runGit(['update-ref', '-d', ref], { gitDir: repo.dir, workTree: repo.workTree }).ok
}

export function listCheckpointRefs(repo: ShadowRepo): string[] {
  const result = runGit(['for-each-ref', '--format=%(refname)', REF_PREFIX], {
    gitDir: repo.dir,
    workTree: repo.workTree,
  })
  if (!result.ok) return []
  return result.stdout.split('\n').map((ref) => ref.trim()).filter(isCheckpointRef)
}

export interface TreeDiff {
  /** 基线之后新增（回退时删除） */
  added: string[]
  /** 有改动（回退时从基线还原） */
  modified: string[]
  /** 基线之后被删除（回退时从基线还原） */
  deleted: string[]
}

export interface TreeDiffResult {
  ok: boolean
  diff: TreeDiff
  error?: string
}

/** 比较两棵 tree，得到精确的变更清单（不需要提交对象）。 */
export function diffTrees(repo: ShadowRepo, fromTree: string, toTree: string): TreeDiffResult {
  const diff: TreeDiff = { added: [], modified: [], deleted: [] }
  if (fromTree === toTree) return { ok: true, diff }
  const result = runGit(['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, toTree], {
    gitDir: repo.dir,
    workTree: repo.workTree,
  })
  if (!result.ok) return { ok: false, diff, error: result.stderr.trim() || 'git diff-tree 失败' }
  const tokens = result.stdout.split('\0').filter((token) => token.length > 0)
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i]
    const rawPath = tokens[i + 1]
    if (!status || !rawPath) continue
    const path = fromGitPath(rawPath)
    if (status.startsWith('A')) diff.added.push(path)
    else if (status.startsWith('D')) diff.deleted.push(path)
    else diff.modified.push(path)
  }
  return { ok: true, diff }
}

/** 从指定 tree 还原给定路径（先 read-tree 把索引切到基线，再按路径 checkout）。 */
export function restorePathsFromTree(repo: ShadowRepo, treeSha: string, gitPaths: string[]): string[] {
  const failed: string[] = []
  const readTree = runGit(['read-tree', treeSha], { gitDir: repo.dir, workTree: repo.workTree })
  if (!readTree.ok) return gitPaths.map(fromGitPath)
  for (let i = 0; i < gitPaths.length; i += ADD_BATCH_SIZE) {
    const batch = gitPaths.slice(i, i + ADD_BATCH_SIZE)
    const result = runGit(['checkout-index', '-f', '--', ...batch], { gitDir: repo.dir, workTree: repo.workTree })
    if (result.ok) continue
    for (const path of batch) {
      const single = runGit(['checkout-index', '-f', '--', path], { gitDir: repo.dir, workTree: repo.workTree })
      if (!single.ok) failed.push(fromGitPath(path))
    }
  }
  return failed
}

/** `git count-objects -v` 的松散对象 + pack 体积，用于回收预算。 */
export function countRepoBytes(repo: ShadowRepo): number {
  const result = runGit(['count-objects', '-v'], { gitDir: repo.dir, workTree: repo.workTree })
  if (!result.ok) return 0
  let bytes = 0
  for (const line of result.stdout.split('\n')) {
    const [key, value] = line.split(':')
    if (!key || !value) continue
    const name = key.trim()
    if (name !== 'size' && name !== 'size-pack') continue
    const kib = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(kib)) bytes += kib * 1024
  }
  return bytes
}

/** 回收不可达对象：删掉检查点 ref 之后调用，让被裁剪的基线真正释放磁盘。 */
export function gcShadowRepo(repo: ShadowRepo): void {
  runGit(['gc', '--prune=now', '--quiet'], { gitDir: repo.dir, workTree: repo.workTree, timeoutMs: GIT_GC_TIMEOUT_MS })
}
