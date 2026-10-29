/**
 * Bash 写入的兜底检测：执行前后对工作目录做一次「只看元数据」的快照。
 *
 * 为什么需要它：`sed -i`、`python3 -c "open(...)"`、heredoc 这些写入不经过
 * Profer 的受控 operations，只能在命令执行后观察文件系统事实。这里刻意只
 * 记录 `(mtimeMs, size)`，不读内容、不做哈希，成本随文件数线性增长。
 *
 * 为什么可以放弃：这不是主路径。主路径是 write/edit 工具的受控写入上报；
 * 快照只负责「Bash 顺带生成了文件」这类场景，因此一旦超出预算就返回 null，
 * 调用方不上报，避免为了兜底把主流程拖慢。
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface FileSnapshotEntry {
  mtimeMs: number
  size: number
}

export type FileSnapshot = Map<string, FileSnapshotEntry>

/** 无回退/无预览价值、且体量通常巨大的目录，直接跳过。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.profer-pi-checkpoints',
  '.turbo',
  '.svelte-kit',
  '.venv',
  'venv',
])

const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_BUDGET_MS = 800

export interface SnapshotOptions {
  maxFiles?: number
  maxDepth?: number
  budgetMs?: number
}

/**
 * 递归记录目录下所有普通文件的元数据。
 *
 * 超过文件数/深度/时间预算时返回 null：调用方据此放弃本轮检测，
 * 而不是拿着半份快照去 diff（半份快照会把「没扫到」误判成「被删除」）。
 */
export async function snapshotTree(root: string, options: SnapshotOptions = {}): Promise<FileSnapshot | null> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const snapshot: FileSnapshot = new Map()

  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > maxDepth || Date.now() > deadline) return false
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 目录不可读不构成失败：权限问题不该让整轮检测放弃。
      return true
    }
    for (const entry of entries) {
      if (snapshot.size >= maxFiles || Date.now() > deadline) return false
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (!(await walk(fullPath, depth + 1))) return false
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(fullPath)
        snapshot.set(fullPath, { mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // 快照期间文件被删除/替换，跳过即可。
      }
    }
    return true
  }

  const complete = await walk(root, 0)
  return complete ? snapshot : null
}

/**
 * 找出 after 中新增或修改的文件（删除不在展示范围内，按需求忽略）。
 *
 * 只比较 `(mtimeMs, size)`：`sed -i`/`cp -p` 会换 inode 但 mtime 可能被保留，
 * 这类边缘场景宁可漏报，也不引入内容哈希的扫描成本。
 */
export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): string[] {
  const changed: string[] = []
  for (const [path, entry] of after) {
    const previous = before.get(path)
    if (!previous || previous.mtimeMs !== entry.mtimeMs || previous.size !== entry.size) {
      changed.push(path)
    }
  }
  return changed
}
