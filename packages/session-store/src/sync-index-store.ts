import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { normalizeSessionIndexData } from '@profer/session-core'
import type { AgentSessionsIndex, SyncSessionIndexStore } from './contracts'
import {
  isPiStateFile,
  mergeSessionIndex,
  resolvePiStatePath,
  splitSessionIndex,
  type PiStateFile,
} from './pi-state-split'

interface FileSignature {
  mtimeMs: number
  size: number
}

/** 上一次写盘时各会话 Pi 字段的对象引用，用于判断独立文件是否真的需要重写。 */
type PiReferenceSnapshot = Map<string, { entryBindings?: unknown; fileCheckpoints?: unknown }>

/** 无效索引不能降级为空列表，否则下一次创建会话会覆盖已有历史。 */
function isSessionIndex(value: unknown): value is AgentSessionsIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<AgentSessionsIndex>
  if (!Array.isArray(candidate.sessions)) return false
  if (candidate.version !== undefined && (typeof candidate.version !== 'number' || !Number.isFinite(candidate.version))) return false
  const ids = new Set<string>()
  for (const session of candidate.sessions) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id.trim() || ids.has(session.id)) return false
    ids.add(session.id)
  }
  return true
}

export function createSyncSessionIndexStore(getPath: () => string, options: { readOnly?: () => boolean } = {}): SyncSessionIndexStore {
  let cache: {
    data: AgentSessionsIndex
    indexSignature: FileSignature | null
    piSignature: FileSignature | null
  } | null = null
  let piReferences: PiReferenceSnapshot | null = null

  const getPiStatePath = (): string => resolvePiStatePath(getPath())

  const statSignature = (filePath: string): FileSignature | null => {
    try {
      const info = statSync(filePath)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return null
    }
  }

  const signatureEquals = (a: FileSignature | null, b: FileSignature | null): boolean => {
    if (a === null || b === null) return a === b
    return a.mtimeMs === b.mtimeMs && a.size === b.size
  }

  const cacheIndex = (data: AgentSessionsIndex): void => {
    cache = {
      data,
      indexSignature: statSignature(getPath()),
      piSignature: statSignature(getPiStatePath()),
    }
  }

  const writeAtomic = (filePath: string, data: unknown, skipBackup = false): void => {
    const directory = dirname(filePath)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    if (!skipBackup && existsSync(filePath)) {
      try { copyFileSync(filePath, `${filePath}.bak`) } catch { /* backup is best effort */ }
    }
    const tempPath = skipBackup ? `${filePath}.recover-${randomUUID()}` : `${filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tempPath, filePath)
  }

  /** Pi 状态文件体积大且更新频率低：用紧凑 JSON，并在替换前留一份 .bak 兜底。 */
  const writePiState = (pi: PiStateFile): void => {
    const filePath = getPiStatePath()
    const directory = dirname(filePath)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    if (existsSync(filePath)) {
      try { copyFileSync(filePath, `${filePath}.bak`) } catch { /* 备份失败不阻断写入 */ }
    }
    const tempPath = `${filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(pi), 'utf8')
    renameSync(tempPath, filePath)
  }

  const readSafe = (): AgentSessionsIndex | null => {
    const filePath = getPath()
    let foundIndex = false
    for (const candidate of [filePath, `${filePath}.tmp`, `${filePath}.bak`]) {
      if (!existsSync(candidate)) continue
      foundIndex = true
      let parsed: unknown
      try {
        const raw = readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')
        parsed = JSON.parse(raw)
      } catch {
        // 保留损坏文件供恢复，不让它遮住后续有效备份。
        continue
      }
      if (!isSessionIndex(parsed)) continue
      if (candidate !== filePath && !options.readOnly?.()) writeAtomic(filePath, parsed, true)
      return parsed
    }
    if (foundIndex) throw new Error(`Agent 会话索引损坏且无可用备份，已阻止覆盖，请先恢复: ${filePath}`)
    const piPath = getPiStatePath()
    const sessionsDir = join(dirname(filePath), 'agent-sessions')
    const hasMessages = existsSync(sessionsDir) && readdirSync(sessionsDir).some(name => name.endsWith('.jsonl'))
    if (hasMessages || [piPath, `${piPath}.tmp`, `${piPath}.bak`].some(path => existsSync(path))) {
      throw new Error(`Agent 会话索引缺失，但历史数据仍存在，已阻止覆盖，请恢复索引: ${filePath}`)
    }
    return null
  }

  const readPiStateSafe = (): PiStateFile | null => {
    const filePath = getPiStatePath()
    for (const candidate of [filePath, `${filePath}.tmp`, `${filePath}.bak`]) {
      if (!existsSync(candidate)) continue
      try {
        const raw = readFileSync(candidate, 'utf8')
        if (!raw.trim()) continue
        const parsed = JSON.parse(raw) as unknown
        if (!isPiStateFile(parsed)) continue
        return parsed
      } catch {
        // 尝试下一个恢复候选。
      }
    }
    return null
  }

  const snapshotPiReferences = (index: AgentSessionsIndex): PiReferenceSnapshot => {
    const snapshot: PiReferenceSnapshot = new Map()
    for (const session of index.sessions) {
      if (session.piEntryBindings === undefined && session.piFileCheckpoints === undefined) continue
      snapshot.set(session.id, {
        entryBindings: session.piEntryBindings,
        fileCheckpoints: session.piFileCheckpoints,
      })
    }
    return snapshot
  }

  /**
   * 判断 Pi 状态文件是否真的需要重写。
   *
   * 会话更新走 `{ ...existing, ...updates }`，未触碰的字段保持同一引用；因此引用
   * 全部相等且条目数不变时可以安全跳过 17MB 的序列化与写盘。
   */
  const piStateChanged = (index: AgentSessionsIndex): boolean => {
    if (!piReferences) return true
    for (const session of index.sessions) {
      const hasPi = session.piEntryBindings !== undefined || session.piFileCheckpoints !== undefined
      if (!hasPi) continue
      const previous = piReferences.get(session.id)
      if (
        !previous
        || previous.entryBindings !== session.piEntryBindings
        || previous.fileCheckpoints !== session.piFileCheckpoints
      ) {
        return true
      }
    }
    // 只减不增（删除会话）时不重写 17MB 状态文件：留下的孤儿条目无害
    // （mergeSessionIndex 只合并仍存在的会话），留到下一次真实变更时一起压缩。
    return false
  }

  const read = (): AgentSessionsIndex => {
    const filePath = getPath()
    if (cache) {
      const indexSignature = statSignature(filePath)
      const piSignature = statSignature(getPiStatePath())
      if (
        signatureEquals(indexSignature, cache.indexSignature)
        && signatureEquals(piSignature, cache.piSignature)
      ) {
        return cache.data
      }
    }

    const normalized = normalizeSessionIndexData(readSafe())
    const light = normalized.index
    // 旧格式迁移：索引里仍带 Pi 大字段时抽到独立文件，并从索引剔除。
    const { light: stripped, pi } = splitSessionIndex(light)
    const needsSplit = stripped !== light
    if (needsSplit && !options.readOnly?.()) {
      try {
        // 顺序关键：先写旁路状态，再剥索引。
        // 反过来的话，第二步失败（ENOSPC/EACCES）会留下「索引已无 Pi 字段、状态文件不存在」
        // 的永久丢数据状态（needsSplit 下次判定为 false，不再重试）。
        writePiState(pi)
        // 首次迁移时 writeAtomic 会把含全量数据的旧索引留到 .bak，作为兜底备份。
        writeAtomic(filePath, stripped)
      } catch {
        // 迁移失败不阻断读取：本次仍返回合并后的完整对象，下次读取再重试。
      }
    } else if (normalized.removedLegacyKnowledgeReferences && !options.readOnly?.()) {
      try { writeAtomic(filePath, light) } catch { cache = null; return light }
    }

    const merged = mergeSessionIndex(stripped, needsSplit ? pi : readPiStateSafe())
    piReferences = snapshotPiReferences(merged)
    cacheIndex(merged)
    return merged
  }

  const write = (index: AgentSessionsIndex): void => {
    if (options.readOnly?.()) throw new Error('会话索引由Core管理，桌面不能写入')
    if (!isSessionIndex(index)) throw new Error('Agent 会话索引格式无效，已阻止写入')
    // 直接 write 和读后外部损坏都必须经过磁盘校验；正常热路径不重复解析索引。
    if (!cache || !cache.indexSignature
      || !signatureEquals(statSignature(getPath()), cache.indexSignature)
      || !signatureEquals(statSignature(getPiStatePath()), cache.piSignature)) {
      readSafe()
    }
    try {
      const { light, pi } = splitSessionIndex(index)
      const piChanged = piStateChanged(index)
      // 先写旁路状态、再写索引：任一步失败都不会出现「索引已更新、状态没写」的单向丢失。
      // 反过来（先索引后状态）在多 store 实例交错时会让旧状态覆盖新状态。
      if (piChanged) writePiState(pi)
      writeAtomic(getPath(), light)
      if (piChanged) piReferences = snapshotPiReferences(index)
      cacheIndex(index)
    } catch (error) {
      cache = null
      throw new Error('写入 Agent 会话索引失败', { cause: error })
    }
  }

  return {
    read,
    write,
    list: (includeArchived = false) => read().sessions
      .filter((session) => includeArchived || !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    countArchived: () => read().sessions.filter((session) => session.archived && !session.draft).length,
    get: (sessionId) => read().sessions.find((session) => session.id === sessionId),
  }
}

export type { AgentSessionMeta }
