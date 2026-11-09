/**
 * 单根文件枚举：把物理目录树翻译成「可提交给 git 的相对路径 + 字节数」。
 *
 * 职责边界很窄，只做一件事：**决定哪些文件进入基线**，并把没能进入的路径连同原因交回去。
 * 它不写 git、不缓存、不重试——这样回退链路里的「快照不完整」永远能被解释成一条具体的
 * skipped 记录，而不是一个静默缺失的文件。
 *
 * 三条安全约束：
 * 1. 显式栈迭代而非递归：用户目录可能深达数百层（node_modules 尤其如此），递归会爆栈，
 *    而爆栈发生在采集过程中，等于整个会话失去快照保护。
 * 2. 符号链接一律不跟随：跟随会逃出根目录（链到 `/` 或另一个盘），既可能无限展开，
 *    也让「快照覆盖的是这个根」这个前提失效。
 * 3. 体积/条目上限只让结果标记 partial，不让整次采集失败：partial 的语义是
 *    「回退时只恢复、不删除」，是安全的降级方向。
 */

import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import type { ShadowFileStat, ShadowLimits, ShadowRoot, ShadowSkipEntry, ShadowWalkResult } from './types'
import {
  isExcludedAbsolutePath,
  shouldSkipShadowDirectory,
  shouldSkipShadowFile,
} from './exclusions'

/**
 * 默认上限。
 *
 * 单文件 50MB：再大的基本是数据库/视频/模型权重，每轮搬一遍只会拖垮采集；
 * 单根 1GB：超过这个量级后 git 对象库的增长已经不可控，不如明确降级为 partial；
 * 单根 20 万条目：对应「十万级文件的大仓」，再往上枚举耗时（而非字节）成为主要成本。
 */
export const DEFAULT_SHADOW_LIMITS: ShadowLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 200_000,
}

/** skipped 里的路径统一写成 `<rootId>/<relativePath>`，便于直接对照 tree 路径定位。 */
function skipPath(rootId: string, relativePath: string): string {
  return relativePath ? `${rootId}/${relativePath}` : rootId
}

/** 只取错误码：错误信息里可能带完整路径，进 journal 会拖长且泄露目录结构。 */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && code ? code : 'unknown'
}

/** 目录项按原始字符串排序；排序结果与平台无关，保证同一棵树的枚举顺序稳定。 */
function compareDirents(left: Dirent, right: Dirent): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

/** 路径相等判断：Windows 下大小写不敏感，与 exclusions 的判定口径保持一致。 */
function isSamePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

interface PendingDirectory {
  absolutePath: string
  relativePath: string
}

/**
 * 枚举单个根。
 *
 * 返回值式错误：根缺失/不可读都通过 skipped 表达，调用方不需要 try/catch。
 */
export async function walkShadowRoot(input: {
  root: ShadowRoot
  excludeAbsolutePaths?: string[]
  limits?: Partial<ShadowLimits>
}): Promise<ShadowWalkResult> {
  const { root } = input
  const limits: ShadowLimits = { ...DEFAULT_SHADOW_LIMITS, ...input.limits }
  // 排除路径先规范化一次：枚举过程中每个条目都要比对，重复 resolve 只是浪费 syscall 之外的 CPU。
  // 与根自身重合的排除项直接丢掉：把根排除掉只会静默产出一棵空树，等于替调用方制造「文件全删了」的假象。
  const rootIdentity = resolve(root.rootPath)
  const excludes = (input.excludeAbsolutePaths ?? [])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => resolve(value))
    .filter((value) => !isSamePath(value, rootIdentity))

  const files: string[] = []
  const skipped: ShadowSkipEntry[] = []
  // 增量索引的文件身份：只对进了基线的文件记录，skipped 的一律不记（否则下次会被误复用）。
  const stats: Record<string, ShadowFileStat> = {}

  let rootStat
  try {
    rootStat = await lstat(root.rootPath)
  } catch (error) {
    const code = errorCode(error)
    // ENOENT/ENOTDIR 说明根已被删除或路径指向文件：这是「根不存在」，不是采集失败。
    const reason = code === 'ENOENT' || code === 'ENOTDIR' ? 'root-missing' : `unreadable: ${code}`
    return {
      files: [],
      skipped: [{ path: root.rootId, reason }],
      totalBytes: 0,
      partial: true,
      rootStatus: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
      stats: {},
    }
  }
  if (!rootStat.isDirectory()) {
    return {
      files: [],
      skipped: [{ path: root.rootId, reason: 'root-not-directory' }],
      totalBytes: 0,
      partial: true,
      rootStatus: 'not-directory',
      stats: {},
    }
  }

  let totalBytes = 0
  // partial = 本次快照不完整；truncated = 因为上限提前停止枚举。
  // 两者必须分开：单个超大文件只是不入基线（partial），不能因此中断后面目录的枚举，
  // 否则「一个大文件 + 子目录」会让整个子树静默漏采。
  let partial = false
  let truncated = false
  let entriesSeen = 0
  const stack: PendingDirectory[] = [{ absolutePath: root.rootPath, relativePath: '' }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    let entries: Dirent[]
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true })
    } catch (error) {
      // 目录读不了（权限、被卸载、路径被替换）只影响这一个子树，别让整次采集失败；
      // 但必须标记 partial：这个子树里的文件会从 tree 里消失，不能当成用户删除了它们。
      partial = true
      skipped.push({
        path: skipPath(root.rootId, current.relativePath),
        reason: `unreadable: ${errorCode(error)}`,
      })
      continue
    }
    entries.sort(compareDirents)

    // 子目录先攒起来再逆序入栈，使出栈顺序与字典序一致：截断时先保留哪些条目是可预期的。
    const childDirectories: PendingDirectory[] = []

    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > limits.maxEntries) {
        partial = true
        truncated = true
        break
      }

      const absolutePath = join(current.absolutePath, entry.name)
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name

      // 排除根自身不跳过（调用方可能把整个工作区交给某个根），但其内部路径按规则排除。
      if (isExcludedAbsolutePath(absolutePath, excludes)) continue

      if (entry.isSymbolicLink()) {
        skipped.push({ path: skipPath(root.rootId, relativePath), reason: 'symlink' })
        continue
      }

      if (entry.isDirectory()) {
        if (shouldSkipShadowDirectory(entry.name)) continue
        childDirectories.push({ absolutePath, relativePath })
        continue
      }

      // dirent 未给出类型（部分文件系统的 DT_UNKNOWN）时必须退回 lstat，
      // 否则会把普通文件当成特殊文件静默漏掉——少捕获在这里是不可恢复的错误。
      let fileStat: Stats | undefined
      if (!entry.isFile()) {
        try {
          fileStat = await lstat(absolutePath)
        } catch (error) {
          skipped.push({
            path: skipPath(root.rootId, relativePath),
            reason: `unreadable: ${errorCode(error)}`,
          })
          continue
        }
        if (fileStat.isSymbolicLink()) {
          skipped.push({ path: skipPath(root.rootId, relativePath), reason: 'symlink' })
          continue
        }
        if (fileStat.isDirectory()) {
          if (shouldSkipShadowDirectory(entry.name)) continue
          childDirectories.push({ absolutePath, relativePath })
          continue
        }
        if (!fileStat.isFile()) {
          // socket / fifo / 设备节点：git 无法表达，强行读还可能阻塞。
          skipped.push({ path: skipPath(root.rootId, relativePath), reason: 'not-regular-file' })
          continue
        }
      }

      if (shouldSkipShadowFile(entry.name)) continue

      // 目录项里的类型与大小来自缓存，可能已过期（文件刚被替换）；以 lstat 为准。
      if (!fileStat) {
        try {
          fileStat = await lstat(absolutePath)
        } catch (error) {
          skipped.push({
            path: skipPath(root.rootId, relativePath),
            reason: `unreadable: ${errorCode(error)}`,
          })
          continue
        }
      }
      if (!fileStat.isFile()) {
        skipped.push({ path: skipPath(root.rootId, relativePath), reason: 'not-regular-file' })
        continue
      }
      if (fileStat.size > limits.maxFileBytes) {
        // 单文件超限只是这一个文件不入基线；但如果它之前进过基线，新 tree 里就会缺它，
        // 所以同样标记 partial，避免后续把它读成「被删除」。
        partial = true
        skipped.push({ path: skipPath(root.rootId, relativePath), reason: 'file-too-large' })
        continue
      }
      if (totalBytes + fileStat.size > limits.maxTotalBytes) {
        partial = true
        truncated = true
        break
      }
      totalBytes += fileStat.size
      files.push(relativePath)
      stats[relativePath] = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ctimeMs: fileStat.ctimeMs,
        ino: fileStat.ino,
        // 只留权限位：文件类型位（S_IFREG 等）对 git 没有意义。
        mode: fileStat.mode & 0o777,
      }
    }

    if (truncated) break

    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      const directory = childDirectories[index]
      if (directory) stack.push(directory)
    }
  }

  // 输出排序是契约的一部分：同一棵树两次采集必须得到逐字相同的 files/skipped，否则 diff 会漂移。
  files.sort()
  skipped.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { files, skipped, totalBytes, partial, rootStatus: 'ok', stats }
}
