import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isPiStateFile, pickPiState, resolvePiStatePath, type PiStateFile } from '@profer/session-store'
import type { AgentSessionMeta } from '@profer/shared'

/**
 * 备份导出 / 导入时的 Pi 状态搬运。
 *
 * 索引拆分后 `piEntryBindings` / `piFileCheckpoints` 存在旁路文件
 * `agent-sessions-pi-state.json` 里。备份如果只带走 `agent-sessions-index.json`，
 * 恢复出来的会话会失去全部回退点绑定（检查点目录还在，但没有任何引用）。
 *
 * 这里把「导出裁剪」与「导入合并」做成纯函数，便于单测，也避免 migration-service
 * 继续散落索引文件格式知识。
 */

/** 备份包内的 Pi 状态条目名。 */
export const EXPORTED_PI_STATE_ENTRY = 'sessions/agent-sessions-pi-state.json'

function readJson(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return raw.trim() ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** 导出：只保留本次真正导出的会话的 Pi 状态；没有可导出内容时返回 null。 */
export function pickPiStatesForExport(
  indexPath: string,
  exportedSessionIds: Iterable<string>,
): PiStateFile | null {
  const ids = new Set(exportedSessionIds)
  if (ids.size === 0) return null
  const piStatePath = resolvePiStatePath(indexPath)
  if (!existsSync(piStatePath)) return null
  const parsed = readJson(piStatePath)
  if (!isPiStateFile(parsed)) return null
  const states = Object.fromEntries(
    Object.entries(parsed.states).filter(([sessionId]) => ids.has(sessionId)),
  )
  if (Object.keys(states).length === 0) return null
  return { version: parsed.version, states }
}

/**
 * 从备份索引条目里提取内联 Pi 状态（兼容拆分前导出的旧备份）。
 *
 * 返回值为 null 表示该条目不携带 Pi 字段；调用方应把返回的 rest 写回索引，
 * 避免旧备份把 20MB 大字段重新灌进轻索引。
 */
export function splitInlinePiState(meta: Record<string, unknown>): {
  inline: PiStateFile['states'][string] | null
  rest: Record<string, unknown>
} {
  const picked = pickPiState(meta as unknown as AgentSessionMeta)
  if (!picked) return { inline: null, rest: meta }
  const { piEntryBindings: _entryBindings, piFileCheckpoints: _fileCheckpoints, ...rest } = meta
  return { inline: picked, rest }
}

/**
 * 导入：把备份里的 Pi 状态合并进本机旁路文件。
 *
 * 只补本机缺失的会话，绝不覆盖已有状态（本机可能已经有更新的检查点映射）。
 *
 * @param sources 按优先级排列的来源（旧备份内联状态、新备份旁路文件）
 * @returns 是否真的写盘
 */
export function mergePiStatesForImport(
  indexPath: string,
  addedSessionIds: Iterable<string>,
  sources: Array<PiStateFile | null | undefined>,
): boolean {
  const added = new Set(addedSessionIds)
  if (added.size === 0) return false
  const usable = sources.filter((source): source is PiStateFile => isPiStateFile(source))
  if (usable.length === 0) return false

  const localPath = resolvePiStatePath(indexPath)
  const localRaw = existsSync(localPath) ? readJson(localPath) : null
  const states: PiStateFile['states'] = isPiStateFile(localRaw) ? { ...localRaw.states } : {}
  let changed = false
  for (const sessionId of added) {
    if (states[sessionId]) continue
    for (const source of usable) {
      const state = source.states[sessionId]
      if (!state) continue
      states[sessionId] = state
      changed = true
      break
    }
  }
  if (!changed) return false
  // 原子替换：导入可能与其他写入并发，半截文件会让所有 Pi 状态一起降级为空。
  const tempPath = `${localPath}.tmp`
  writeFileSync(tempPath, JSON.stringify({ version: 1, states }), 'utf-8')
  renameSync(tempPath, localPath)
  return true
}

/** 读取备份包里的旁路 Pi 状态文件。 */
export function readExportedPiState(tempDir: string): PiStateFile | null {
  const parsed = readJson(`${tempDir}/${EXPORTED_PI_STATE_ENTRY}`)
  return isPiStateFile(parsed) ? parsed : null
}
