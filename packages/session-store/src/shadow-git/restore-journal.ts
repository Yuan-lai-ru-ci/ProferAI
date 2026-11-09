/**
 * 回退 journal。
 *
 * 回退是本项目里唯一会**主动改写用户文件**的操作，因此必须留下两种证据：
 * 1. 回退前的保护快照（采集 commit，由上层负责）；
 * 2. 这次回退到底对每个文件做了什么决定。
 *
 * 崩溃恢复靠「追加写 + 同一 restoreId 的最后一行是结论」：
 * - 开始前追加一条 `pending`；
 * - 结束后追加一条 `completed` / `failed`；
 * - 进程在中间被杀，文件里最后一条就是 `pending`，下次启动能明确知道「有一次回退没走完」，
 *   而不是靠「文件内容看起来不对」去猜。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ShadowRestoreJournalOutcome {
  /** 与 reverse-patch 的 action 对齐：restore/delete/keep-current/skip。 */
  path: string
  action: string
  reason: string
}

export interface ShadowRestoreJournalEntry {
  schemaVersion: 1
  restoreId: string
  workspaceId: string
  sessionId: string
  turnId: string
  status: 'pending' | 'completed' | 'failed' | 'interrupted'
  startedAt: number
  completedAt?: number
  /** 回退前的保护快照边界；缺省表示保护快照没建成（此时不应该继续写盘）。 */
  protectionCommitId?: string
  /** 计划或结果；pending 阶段是计划，结束阶段是实际结论。 */
  outcomes?: ShadowRestoreJournalOutcome[]
  counts?: { restored: number; deleted: number; kept: number; skipped: number }
  error?: string
}

export const SHADOW_RESTORE_JOURNAL_FILE = 'restore-journal.jsonl'

function restoreJournalPath(shadowDir: string): string {
  return join(shadowDir, SHADOW_RESTORE_JOURNAL_FILE)
}

export function appendShadowRestoreEntry(shadowDir: string, entry: ShadowRestoreJournalEntry): void {
  mkdirSync(shadowDir, { recursive: true })
  writeFileSync(restoreJournalPath(shadowDir), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
}

export function readShadowRestoreJournal(shadowDir: string, limit = 50): ShadowRestoreJournalEntry[] {
  const file = restoreJournalPath(shadowDir)
  if (!existsSync(file)) return []
  const entries: ShadowRestoreJournalEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ShadowRestoreJournalEntry
      if (parsed?.schemaVersion === 1) entries.push(parsed)
    } catch {
      continue
    }
  }
  return entries.length > limit ? entries.slice(entries.length - limit) : entries
}

/**
 * 最近一条没有结论的回退。
 *
 * 只按 restoreId 的最后一条状态判断：同一个 id 后来追加了 completed 就不再算未完成，
 * 这样不需要「原地修改」历史行（原地改写在崩溃时会留下半个 JSON）。
 */
export function findUnfinishedRestore(shadowDir: string): ShadowRestoreJournalEntry | undefined {
  const lastByRestore = new Map<string, ShadowRestoreJournalEntry>()
  for (const entry of readShadowRestoreJournal(shadowDir, 500)) lastByRestore.set(entry.restoreId, entry)
  let unfinished: ShadowRestoreJournalEntry | undefined
  for (const entry of lastByRestore.values()) {
    if (entry.status !== 'pending') continue
    if (!unfinished || entry.startedAt > unfinished.startedAt) unfinished = entry
  }
  return unfinished
}
