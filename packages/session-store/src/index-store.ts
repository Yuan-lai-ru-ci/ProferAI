import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeSessionIndexData } from '@profer/session-core'
import type { AgentSessionsIndex, SessionIndexStore, SessionStorePaths } from './contracts'
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

interface CacheEntry {
  data: AgentSessionsIndex
  indexSignature: FileSignature | null
  piSignature: FileSignature | null
}

type PiReferenceSnapshot = Map<string, { entryBindings?: unknown; fileCheckpoints?: unknown }>

export function createSessionIndexStore(paths: SessionStorePaths): SessionIndexStore {
  let cache: CacheEntry | null = null
  let piReferences: PiReferenceSnapshot | null = null
  let writeTail: Promise<void> = Promise.resolve()

  const piStatePath = (): string => resolvePiStatePath(paths.sessionsIndex)

  const statSignature = async (filePath: string): Promise<FileSignature | null> => {
    try {
      const info = await stat(filePath)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return null
    }
  }

  const signatureEquals = (a: FileSignature | null, b: FileSignature | null): boolean => {
    if (a === null || b === null) return a === b
    return a.mtimeMs === b.mtimeMs && a.size === b.size
  }

  const writeAtomic = async (filePath: string, data: unknown, skipBackup = false): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true })
    if (!skipBackup) {
      try { await copyFile(filePath, `${filePath}.bak`) } catch { /* 备份失败不阻断索引写入 */ }
    }
    await writeFile(`${filePath}.tmp`, JSON.stringify(data, null, 2), 'utf8')
    await rename(`${filePath}.tmp`, filePath)
  }

  /** Pi 状态文件体积大且更新频率低：用紧凑 JSON，并在替换前留一份 .bak 兜底。 */
  const writePiState = async (pi: PiStateFile): Promise<void> => {
    const filePath = piStatePath()
    await mkdir(dirname(filePath), { recursive: true })
    try { await copyFile(filePath, `${filePath}.bak`) } catch { /* 备份失败不阻断写入 */ }
    await writeFile(`${filePath}.tmp`, JSON.stringify(pi), 'utf8')
    await rename(`${filePath}.tmp`, filePath)
  }

  const readSafe = async (): Promise<AgentSessionsIndex | null> => {
    for (const candidate of [paths.sessionsIndex, `${paths.sessionsIndex}.tmp`, `${paths.sessionsIndex}.bak`]) {
      try {
        const raw = await readFile(candidate, 'utf8')
        if (!raw.trim()) continue
        const parsed = JSON.parse(raw) as AgentSessionsIndex
        if (candidate !== paths.sessionsIndex) await writeAtomic(paths.sessionsIndex, parsed, true)
        return parsed
      } catch {
        // Try the next recovery candidate.
      }
    }
    return null
  }

  const readPiStateSafe = async (): Promise<PiStateFile | null> => {
    const filePath = piStatePath()
    for (const candidate of [filePath, `${filePath}.tmp`, `${filePath}.bak`]) {
      try {
        const raw = await readFile(candidate, 'utf8')
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

  const cacheIndex = async (data: AgentSessionsIndex): Promise<void> => {
    cache = {
      data,
      indexSignature: await statSignature(paths.sessionsIndex),
      piSignature: await statSignature(piStatePath()),
    }
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

  /** 引用未变且条目数一致时跳过独立文件重写，避免每次元数据更新都序列化十几 MB。 */
  const piStateChanged = (index: AgentSessionsIndex): boolean => {
    if (!piReferences) return true
    let count = 0
    for (const session of index.sessions) {
      const hasPi = session.piEntryBindings !== undefined || session.piFileCheckpoints !== undefined
      if (!hasPi) continue
      count += 1
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

  const read = async (): Promise<AgentSessionsIndex> => {
    if (cache) {
      const indexSignature = await statSignature(paths.sessionsIndex)
      const piSignature = await statSignature(piStatePath())
      if (
        signatureEquals(indexSignature, cache.indexSignature)
        && signatureEquals(piSignature, cache.piSignature)
      ) {
        return cache.data
      }
    }
    const normalized = normalizeSessionIndexData(await readSafe())
    const light = normalized.index
    const { light: stripped, pi } = splitSessionIndex(light)
    const needsSplit = stripped !== light
    if (needsSplit) {
      try {
        // 顺序关键：先写旁路状态，再剥索引（失败可重试，不会单向丢数据）。
        await writePiState(pi)
        await writeAtomic(paths.sessionsIndex, stripped)
      } catch {
        // 迁移失败不阻断读取：本次仍返回合并后的完整对象，下次读取再重试。
      }
    } else if (normalized.removedLegacyKnowledgeReferences) {
      try { await writeAtomic(paths.sessionsIndex, light) } catch { cache = null }
    }
    const merged = mergeSessionIndex(stripped, needsSplit ? pi : await readPiStateSafe())
    piReferences = snapshotPiReferences(merged)
    await cacheIndex(merged)
    return merged
  }

  const write = async (index: AgentSessionsIndex): Promise<void> => {
    const next = writeTail.then(async () => {
      try {
        const { light, pi } = splitSessionIndex(index)
        const piChanged = piStateChanged(index)
        // 先写旁路状态、再写索引：避免多实例交错时旧状态覆盖新状态。
        if (piChanged) await writePiState(pi)
        await writeAtomic(paths.sessionsIndex, light)
        if (piChanged) piReferences = snapshotPiReferences(index)
        await cacheIndex(index)
      } catch (error) {
        cache = null
        throw new Error('写入 Agent 会话索引失败', { cause: error })
      }
    })
    writeTail = next.catch(() => {})
    return next
  }

  return {
    read,
    write,
    list: async (includeArchived = false) => (await read()).sessions
      .filter((session) => includeArchived || !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    countArchived: async () => (await read()).sessions.filter((session) => session.archived && !session.draft).length,
    get: async (sessionId) => (await read()).sessions.find((session) => session.id === sessionId),
  }
}
