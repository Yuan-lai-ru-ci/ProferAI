/**
 * 多根工作区 tree 的拼装层。
 *
 * 目标形状：一个 workspace 的 tree 里，每个根目录挂在 `roots/<rootId>/` 下，
 * 于是「跨根同名文件」不会互相覆盖，diff 也能直接按根判断归属。
 *
 * 实现方式是纯 git 原生对象操作，没有 checkout / reset / clean：
 * 每个根一个**独立临时索引**（并行安全、互不污染），逐个 `write-tree` 得到子树，
 * 再用第三个索引 `read-tree --prefix` 把它们合成为一棵树，最后 `write-tree`。
 * 因此用户仓库的工作区、索引、HEAD 从头到尾都不被触碰。
 *
 * 文件内容通过 `hash-object -w` 直接写入对象库、再 `update-index --index-info` 登记，
 * 而不是 `git add`：后者在含嵌套仓库（目录里又有 `.git`）的根里会静默跳过整棵子树。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { GitRunner } from './git-command'
import type { ShadowManifestEntry } from './manifest'
import type { ShadowFileStat } from './types'

export interface ShadowTreeRootInput {
  rootId: string
  rootPath: string
  /** 相对 rootPath 的规范路径（正斜杠，已由 walk 层排序）。 */
  files: string[]
  /** 本次枚举到的 stat；缺了某个文件时该文件一定重新哈希。 */
  stats?: Record<string, ShadowFileStat>
  /** 上一次成功采集留下的清单；只有 stat（含 mode）完全一致的文件才复用 sha。 */
  previous?: Record<string, ShadowManifestEntry>
}

export interface ShadowTreeRootResult {
  rootId: string
  treeSha: string
  /** 无法写入对象库的路径；不得让整次构建失败，回退时也不能当作删除。 */
  failures: string[]
  /** 本次可交给下一次采集的清单（只含真正进了索引的文件）。 */
  manifest: Record<string, ShadowManifestEntry>
  /** 复用了多少条上次的 sha（诊断用）。 */
  reused: number
  /** 实际重新哈希了多少个文件（诊断用）。 */
  hashed: number
}

export interface ShadowTreeBuildResult {
  ok: boolean
  treeSha: string
  perRoot: ShadowTreeRootResult[]
  error?: string
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

/** 未配置 git 身份的机器上 commit-tree 会失败，显式给一个本地身份。 */
const COMMIT_IDENTITY = ['-c', 'user.name=Profer', '-c', 'user.email=profer@localhost']

const pathSeparatorPattern = /\\/g

export function isObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value)
}

/**
 * git 内部路径统一用正斜杠。Windows 上 walk 层可能给出反斜杠，
 * 这里统一转换（比让调用方各自记得转换更可靠）。
 *
 * 刻意不导出：roots.ts 已有同名工具，重复导出会让 barrel 出现歧义。
 */
function toGitRelativePath(relativePath: string): string {
  return relativePath.replace(pathSeparatorPattern, '/')
}

/** rootId 会直接进入 ref/tree 路径，必须是一个安全的单段名字。 */
function isSafeRootId(rootId: string): boolean {
  if (rootId.length === 0 || rootId.length > 128) return false
  if (rootId === '.' || rootId === '..') return false
  // 名字里出现分隔符或控制字符会破坏 roots/<rootId>/ 的前缀语义。
  return !/[/\\\u0000-\u001f\u007f]/.test(rootId)
}

/** 相对路径防御性校验：绝对路径与 `.`/`..` 段会把写入点带出根本身。 */
function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return false
  const unified = toGitRelativePath(relativePath)
  if (unified.startsWith('/')) return false
  // Windows 盘符形式（C:/x）在 posix 上看不出是绝对路径。
  if (/^[a-zA-Z]:\//.test(unified)) return false
  if (unified.includes('\u0000')) return false
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/** 每批 200 个路径：远低于 argv 长度上限，也不会因单批失败丢掉整个根。 */
const HASH_BATCH_SIZE = 200

/**
 * 决定 index 里登记的 git mode。
 *
 * 只区分 100644 / 100755：git 能表达的普通文件就这两种（120000 是符号链接，walk 层已排除；
 * 160000 是子模块，我们不记录）。没有 stat 时保守用 100644——宁可少一个可执行位，
 * 也不要给用户文件凭空加上可执行权限。
 */
function gitModeFor(stat: ShadowFileStat | undefined): '100644' | '100755' {
  if (!stat) return '100644'
  return (stat.mode & 0o111) !== 0 ? '100755' : '100644'
}

/**
 * 把一组显式路径写进对象库并登记到索引，返回仍然失败的路径。
 *
 * 为什么不用 `git add`：在一个含嵌套仓库（仓库内又有 `.git`，例如 `.pi/`、submodule、
 * 自带版本库的 vendor 目录）的根里，`git add <嵌套仓库内的文件>` 会**静默地退出 0 但不加入任何条目**，
 * 于是快照看起来成功、实际丢了整棵子树。改走 `hash-object -w` + `update-index --index-info`：
 * 直接按文件字节写对象，不经过工作树路径规则，嵌套仓库里的文件同样能被如实记录。
 *
 * 副作用：`--no-filters` 保证写入的字节与磁盘一致，不被用户项目的 autocrlf/eol
 * 设置改写；可执行位按 stat.mode 登记为 100755 / 100644，否则「删掉 0755 脚本再回退」
 * 只能恢复内容、丢掉权限。
 */
async function hashPathsIntoIndex(
  runner: GitRunner,
  params: {
    repoDir: string
    rootPath: string
    indexFile: string
    stats?: Record<string, ShadowFileStat>
    previous?: Record<string, ShadowManifestEntry>
  },
  gitPaths: string[],
): Promise<{ failures: string[]; manifest: Record<string, ShadowManifestEntry>; reused: number; hashed: number }> {
  const manifest: Record<string, ShadowManifestEntry> = {}
  if (gitPaths.length === 0) return { failures: [], manifest, reused: 0, hashed: 0 }
  const options = { gitDir: params.repoDir, workTree: params.rootPath }
  const failures: string[] = []
  const entries: Array<{ path: string; sha: string; mode: '100644' | '100755' }> = []

  // 先分流：stat 与上次清单完全一致的文件直接复用 sha，只有其余文件需要读内容。
  const needHash: string[] = []
  for (const path of gitPaths) {
    const stat = params.stats?.[path]
    const previous = params.previous?.[path]
    if (
      stat &&
      previous &&
      previous.size === stat.size &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.ctimeMs === stat.ctimeMs &&
      previous.ino === stat.ino &&
      // 旧清单没有 mode：不复用，否则已有工作区在修复后仍不会重新登记 100755。
      previous.mode === stat.mode
    ) {
      manifest[path] = { ...stat, sha: previous.sha }
      entries.push({ path, sha: previous.sha, mode: gitModeFor(stat) })
      continue
    }
    needHash.push(path)
  }

  for (let offset = 0; offset < needHash.length; offset += HASH_BATCH_SIZE) {
    const batch = needHash.slice(offset, offset + HASH_BATCH_SIZE)
    // `--` 放在路径前：文件名以 `-` 开头时不会被当成选项。
    const hashed = await runner.run(['hash-object', '-w', '--no-filters', '--', ...batch], options)
    const shas = hashed.ok ? hashed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
    if (hashed.ok && shas.length === batch.length) {
      batch.forEach((path, index) => {
        const sha = shas[index]
        if (sha && isObjectId(sha)) record(path, sha)
        else failures.push(path)
      })
      continue
    }
    // 批量结果不可信（个别文件被删/被占用会整体失败）：逐文件重试，把失败定位到具体路径。
    for (const path of batch) {
      const single = await runner.run(['hash-object', '-w', '--no-filters', '--', path], options)
      const sha = single.ok ? single.stdout.trim() : ''
      if (isObjectId(sha)) record(path, sha)
      else failures.push(path)
    }
  }

  function record(path: string, sha: string): void {
    const stat = params.stats?.[path]
    entries.push({ path, sha, mode: gitModeFor(stat) })
    // 没有 stat 的文件不写进清单：下次没有比较依据，宁可重新哈希。
    if (stat) manifest[path] = { ...stat, sha }
  }

  if (entries.length === 0) return { failures, manifest, reused: 0, hashed: needHash.length }

  // `--index-info` 必须是最后一个参数；-z 让路径用 NUL 分隔，文件名含换行也不会错位。
  const indexInfo = entries.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\u0000`).join('')
  const updated = await runner.run(['update-index', '-z', '--add', '--index-info'], {
    ...options,
    indexFile: params.indexFile,
    input: indexInfo,
  })
  if (updated.ok) return { failures, manifest, reused: gitPaths.length - needHash.length, hashed: needHash.length - failures.length }

  // 极老 git 不支持 -z/--index-info 组合：逐个登记，能写多少写多少，剩下的如实报告。
  for (const entry of entries) {
    const single = await runner.run(
      ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`],
      {
        ...options,
        indexFile: params.indexFile,
      },
    )
    if (!single.ok) {
      failures.push(entry.path)
      // 没进索引的文件不能留在清单里，否则下次会「复用」一个根本不在 tree 的条目。
      delete manifest[entry.path]
    }
  }
  return { failures, manifest, reused: gitPaths.length - needHash.length, hashed: needHash.length - failures.length }
}

/** 一次构建只用一个临时索引文件；失败也要删干净，否则下次会读到脏索引。 */
function makeIndexPath(tempDir: string, label: string): string {
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return join(tempDir, `index-${safeLabel}-${randomUUID()}`)
}

function removeIndexFile(indexFile: string): void {
  try {
    rmSync(indexFile, { force: true })
  } catch {
    /* 临时文件残留不影响正确性，系统临时目录会被清理 */
  }
}

async function writeTree(runner: GitRunner, repoDir: string, workTree: string, indexFile: string): Promise<string> {
  const result = await runner.run(['write-tree'], { gitDir: repoDir, workTree, indexFile })
  if (!result.ok) return ''
  const sha = result.stdout.trim()
  return isObjectId(sha) ? sha : ''
}

export async function buildShadowWorkspaceTree(
  runner: GitRunner,
  params: { repoDir: string; tempDir: string; roots: ShadowTreeRootInput[] },
): Promise<ShadowTreeBuildResult> {
  const perRoot: ShadowTreeRootResult[] = []
  if (params.roots.length === 0) {
    return { ok: false, treeSha: '', perRoot, error: '没有可采集的根目录' }
  }
  try {
    mkdirSync(params.tempDir, { recursive: true })
  } catch (error) {
    return { ok: false, treeSha: '', perRoot, error: `无法创建临时目录：${describeError(error)}` }
  }

  for (const root of params.roots) {
    if (!isSafeRootId(root.rootId)) {
      return { ok: false, treeSha: '', perRoot, error: `根标识不合法：${root.rootId}` }
    }
    const indexFile = makeIndexPath(params.tempDir, root.rootId)
    removeIndexFile(indexFile)
    const failures: string[] = []
    try {
      const accepted: string[] = []
      for (const file of root.files) {
        // 不合法路径只算该文件的失败，不能让它把整根目录搞崩。
        if (isSafeRelativePath(file)) accepted.push(toGitRelativePath(file))
        else failures.push(file)
      }
      const hashed = await hashPathsIntoIndex(
        runner,
        {
          repoDir: params.repoDir,
          rootPath: root.rootPath,
          indexFile,
          ...(root.stats ? { stats: root.stats } : {}),
          ...(root.previous ? { previous: root.previous } : {}),
        },
        accepted,
      )
      failures.push(...hashed.failures)
      // 空根目录也要产出空树，让「根存在但暂时没有文件」与「根被移除」在 diff 上可区分。
      const treeSha = await writeTree(runner, params.repoDir, root.rootPath, indexFile)
      if (!treeSha) {
        return {
          ok: false,
          treeSha: '',
          perRoot,
          error: `write-tree 失败（rootId=${root.rootId}，workTree=${root.rootPath}）`,
        }
      }
      perRoot.push({
        rootId: root.rootId,
        treeSha,
        failures,
        manifest: hashed.manifest,
        reused: hashed.reused,
        hashed: hashed.hashed,
      })
    } finally {
      removeIndexFile(indexFile)
    }
  }

  const compositeIndex = makeIndexPath(params.tempDir, 'composite')
  removeIndexFile(compositeIndex)
  try {
    for (const root of perRoot) {
      // 关键坑：bare 仓库里 read-tree --prefix 必须能定位到 work tree，
      // 否则报 'this operation must be run in a work tree'；这里把 workTree 指回仓库自身。
      const readTree = await runner.run(['read-tree', `--prefix=roots/${root.rootId}/`, root.treeSha], {
        gitDir: params.repoDir,
        workTree: params.repoDir,
        indexFile: compositeIndex,
      })
      if (!readTree.ok) {
        return {
          ok: false,
          treeSha: '',
          perRoot,
          error: readTree.stderr.trim() || `read-tree 失败（rootId=${root.rootId}）`,
        }
      }
    }
    const compositeTree = await writeTree(runner, params.repoDir, params.repoDir, compositeIndex)
    if (!compositeTree) {
      return { ok: false, treeSha: '', perRoot, error: '合成树 write-tree 失败' }
    }
    return { ok: true, treeSha: compositeTree, perRoot }
  } finally {
    removeIndexFile(compositeIndex)
  }
}

export async function commitShadowTree(
  runner: GitRunner,
  params: { repoDir: string; treeSha: string; message: string; parentCommitId?: string },
): Promise<{ ok: boolean; commitId: string }> {
  if (!isObjectId(params.treeSha)) return { ok: false, commitId: '' }
  if (params.parentCommitId !== undefined && !isObjectId(params.parentCommitId)) {
    return { ok: false, commitId: '' }
  }
  const args = [...COMMIT_IDENTITY, 'commit-tree', params.treeSha, '-m', params.message]
  if (params.parentCommitId) args.push('-p', params.parentCommitId)
  const result = await runner.run(args, { gitDir: params.repoDir })
  if (!result.ok) return { ok: false, commitId: '' }
  const commitId = result.stdout.trim()
  return isObjectId(commitId) ? { ok: true, commitId } : { ok: false, commitId: '' }
}

/**
 * 解析 ref 指向的 commit。
 *
 * 允许传对象 id（父链查询时更直接），其余情况只接受 `refs/` 下的安全 ref，
 * 避免把任意字符串送进 rev-parse 的 revision 语法（如 `HEAD@{...}`）。
 */
/** 解析某个 commit 的 tree sha；commit 不存在或不是提交时返回 null。 */
export async function resolveCommitTree(runner: GitRunner, repoDir: string, commitId: string): Promise<string | null> {
  if (!isObjectId(commitId)) return null
  const result = await runner.run(['rev-parse', `${commitId}^{tree}`], { gitDir: repoDir })
  if (!result.ok) return null
  const sha = result.stdout.trim()
  return isObjectId(sha) ? sha : null
}

export async function resolveShadowCommit(runner: GitRunner, repoDir: string, ref: string): Promise<string | null> {
  if (!isObjectId(ref) && ref !== 'HEAD' && !isSafeShadowRef(ref)) return null
  const result = await runner.run(['rev-parse', '--verify', '--quiet', ref], { gitDir: repoDir })
  if (!result.ok) return null
  const sha = result.stdout.trim()
  return isObjectId(sha) ? sha : null
}

export async function updateShadowRef(
  runner: GitRunner,
  repoDir: string,
  ref: string,
  commitId: string,
): Promise<boolean> {
  if (!isSafeShadowRef(ref) || !isObjectId(commitId)) return false
  const result = await runner.run(['update-ref', ref, commitId], { gitDir: repoDir })
  return result.ok
}

export async function diffShadowTrees(
  runner: GitRunner,
  repoDir: string,
  fromTree: string,
  toTree: string,
): Promise<{ ok: boolean; diff: { added: string[]; modified: string[]; deleted: string[] }; error?: string }> {
  const diff = { added: [] as string[], modified: [] as string[], deleted: [] as string[] }
  if (!isObjectId(fromTree) || !isObjectId(toTree)) {
    return { ok: false, diff, error: 'tree 对象 id 不合法' }
  }
  // 同一棵树是最常见情况（本轮没有任何改动），不必起进程。
  if (fromTree === toTree) return { ok: true, diff }

  const result = await runner.run(
    ['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, toTree],
    { gitDir: repoDir },
  )
  if (!result.ok) {
    return { ok: false, diff, error: result.stderr.trim() || 'git diff-tree 失败' }
  }
  const tokens = result.stdout.split('\u0000')
  for (let offset = 0; offset + 1 < tokens.length; offset += 2) {
    const status = tokens[offset]
    const path = tokens[offset + 1]
    if (!status || !path) continue
    // 路径按 posix 原样返回：上层用它拼 roots/<rootId>/<path> 做展示与回退。
    if (status.startsWith('A')) diff.added.push(path)
    else if (status.startsWith('D')) diff.deleted.push(path)
    else diff.modified.push(path)
  }
  return { ok: true, diff }
}

/** 每个工作区一个 head ref；ref 名里带 workspaceId 便于人工排查。 */
export function shadowWorkspaceHeadRef(workspaceId: string): string {
  return `refs/profer/shadow-workspaces/${workspaceId}/head`
}

/**
 * 判断一个字符串能否安全地当 ref 使用。
 *
 * 规则比 git check-ref-format 更严一点：只放行 `refs/` 下的层级引用，
 * 因为这一层永远不需要 tag、`HEAD~1` 或 `@{}` 这类 revision 语法。
 */
export function isSafeShadowRef(value: string): boolean {
  if (!value.startsWith('refs/')) return false
  if (value.length > 255) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false
  if (value.endsWith('/') || value.endsWith('.')) return false
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(value)) return false
  for (const segment of value.split('/')) {
    if (segment.length === 0) return false
    if (segment.startsWith('.')) return false
    if (segment.endsWith('.lock')) return false
  }
  return true
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
