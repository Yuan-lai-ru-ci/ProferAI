export interface ClaudeHistoryEntry {
  uuid?: string
  type?: string
  isSnapshotUpdate?: boolean
  snapshot?: { messageId?: string; trackedFileBackups?: Record<string, { backupFileName: string | null }> }
}
/** 提取桌面 snapshot 规则：完整快照优先，增量只补缺失项，再收集后续新建文件。 */
export function planClaudeFileRewind(entries: readonly ClaudeHistoryEntry[], userMessageId: string): Map<string, string | null> {
  const target = entries.findIndex(entry => entry.uuid === userMessageId)
  if (target < 0) throw new Error('原生 transcript 中未找到目标 user 消息')
  const state = new Map<string, string | null>()
  let found = false
  for (const entry of entries) {
    if (entry.type !== 'file-history-snapshot' || entry.isSnapshotUpdate || entry.snapshot?.messageId !== userMessageId || !entry.snapshot.trackedFileBackups) continue
    for (const [path, backup] of Object.entries(entry.snapshot.trackedFileBackups)) state.set(path, backup.backupFileName)
    found = true
  }
  if (!found) throw new Error('目标消息没有文件快照记录')
  for (const entry of entries) {
    if (entry.type !== 'file-history-snapshot' || !entry.isSnapshotUpdate || entry.snapshot?.messageId !== userMessageId) continue
    for (const [path, backup] of Object.entries(entry.snapshot.trackedFileBackups ?? {})) if (!state.has(path)) state.set(path, backup.backupFileName)
  }
  for (const entry of entries.slice(target + 1)) {
    if (entry.type !== 'file-history-snapshot') continue
    for (const [path, backup] of Object.entries(entry.snapshot?.trackedFileBackups ?? {})) if (!state.has(path) && backup.backupFileName === null) state.set(path, null)
  }
  return state
}
