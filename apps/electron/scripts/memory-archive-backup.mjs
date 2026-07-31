#!/usr/bin/env node
/**
 * memory-archive 主题记忆快照备份脚本
 *
 * 把工作区 workspace-files/.context/memory-archive/ 增量复制到同级
 * memory-archive-backup/ 下带时间戳的子目录，并轮转只保留最近 KEEP 份。
 * 供 automation 定时任务调用，作为 Pi 可写专属记忆目录的版本化兜底。
 *
 * 用法：
 *   node memory-archive-backup.mjs <workspaceSlug> [--keep N]
 *
 * 示例：
 *   node memory-archive-backup.mjs profer --keep 14
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, statSync } from 'node:fs'

const DEFAULT_KEEP = 14

function parseArgs(argv) {
  const args = argv.slice(2)
  const slug = args.find((a) => !a.startsWith('--'))
  const keepIdx = args.indexOf('--keep')
  const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : DEFAULT_KEEP
  return { slug, keep: Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP }
}

function timestampDir(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function run() {
  const { slug, keep } = parseArgs(process.argv)
  if (!slug) {
    console.error('[memory-backup] 缺少 workspaceSlug，用法: node memory-archive-backup.mjs <workspaceSlug> [--keep N]')
    process.exitCode = 1
    return
  }

  const contextDir = join(homedir(), '.profer', 'agent-workspaces', slug, 'workspace-files', '.context')
  const srcDir = join(contextDir, 'memory-archive')
  const backupRoot = join(contextDir, 'memory-archive-backup')

  if (!existsSync(srcDir)) {
    console.log(`[memory-backup] 源目录不存在，跳过: ${srcDir}`)
    return
  }
  mkdirSync(backupRoot, { recursive: true })

  const dest = join(backupRoot, timestampDir())
  cpSync(srcDir, dest, { recursive: true })
  console.log(`[memory-backup] 已备份 memory-archive 到: ${dest}`)

  // 轮转：按名字（YYYYMMDD-HHmmss 可字典序比较）保留最近 keep 份
  const snapshots = readdirSync(backupRoot)
    .filter((name) => {
      const p = join(backupRoot, name)
      return statSync(p).isDirectory() && /^\d{8}-\d{6}$/.test(name)
    })
    .sort()

  while (snapshots.length > keep) {
    const toRemove = snapshots.shift()
    if (!toRemove) break
    rmSync(join(backupRoot, toRemove), { recursive: true, force: true })
    console.log(`[memory-backup] 轮转删除旧快照: ${toRemove}`)
  }

  console.log(`[memory-backup] 完成，当前保留快照数: ${Math.min(snapshots.length, keep)}/${keep}`)
}

run()
