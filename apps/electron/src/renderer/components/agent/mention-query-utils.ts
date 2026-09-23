import type { FileIndexEntry, FileSearchResult, WorkspaceCapabilities } from '@profer/shared'

const CAPABILITIES_CACHE_TTL_MS = 30_000
const FILE_SNAPSHOT_CACHE_TTL_MS = 30_000

interface TimedCacheEntry<T> {
  value: Promise<T>
  createdAt: number
}

const capabilitiesCache = new Map<string, TimedCacheEntry<WorkspaceCapabilities>>()
const fileSnapshotCache = new Map<string, TimedCacheEntry<FileSearchResult>>()
let mentionCacheGeneration = 0

export const MENTION_DEBOUNCE_MS = 35
export const MAX_MENTION_ITEMS = 50
export const MAX_FILE_MENTION_ITEMS = 200

/**
 * 在 renderer 生命周期内复用同一工作区的能力摘要。
 * Promise 也会被缓存，避免快速触发时并发读取同一份能力数据。
 */
export function invalidateWorkspaceCapabilitiesCache(slug?: string): void {
  mentionCacheGeneration += 1
  if (slug) {
    capabilitiesCache.delete(slug)
    return
  }
  capabilitiesCache.clear()
}

export function invalidateFileSnapshotCache(): void {
  mentionCacheGeneration += 1
  fileSnapshotCache.clear()
}

export function getMentionCacheGeneration(): number {
  return mentionCacheGeneration
}

export function getCachedWorkspaceCapabilities(slug: string): Promise<WorkspaceCapabilities> {
  const now = Date.now()
  const cached = capabilitiesCache.get(slug)
  if (cached && now - cached.createdAt < CAPABILITIES_CACHE_TTL_MS) return cached.value

  const value = window.electronAPI.getWorkspaceCapabilities(slug).catch((error: unknown) => {
    capabilitiesCache.delete(slug)
    throw error
  })
  capabilitiesCache.set(slug, { value, createdAt: now })
  return value
}

function normalizePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean))).sort()
}

export function createFileSnapshotKey(rootPath: string, additionalPaths: string[], sessionPaths: string[]): string {
  return JSON.stringify([rootPath, normalizePaths(additionalPaths), normalizePaths(sessionPaths)])
}

/** 首次激活文件 mention 时获取有限快照；后续 query 仅在 renderer 内过滤。 */
export function getCachedFileSnapshot(
  rootPath: string,
  additionalPaths: string[],
  sessionPaths: string[],
): Promise<FileSearchResult> {
  const key = createFileSnapshotKey(rootPath, additionalPaths, sessionPaths)
  const now = Date.now()
  const cached = fileSnapshotCache.get(key)
  if (cached && now - cached.createdAt < FILE_SNAPSHOT_CACHE_TTL_MS) return cached.value

  const value = window.electronAPI.searchWorkspaceFiles(
    rootPath,
    '',
    2000,
    additionalPaths.length > 0 ? additionalPaths : undefined,
    sessionPaths.length > 0 ? sessionPaths : undefined,
  ).catch((error: unknown) => {
    fileSnapshotCache.delete(key)
    throw error
  })
  fileSnapshotCache.set(key, { value, createdAt: now })
  return value
}

function fuzzyMatch(entry: FileIndexEntry, query: string): boolean {
  if (!query) return true
  const name = entry.name.toLowerCase()
  const path = entry.path.toLowerCase()
  if (name.startsWith(query) || name.includes(query) || path.includes(query)) return true

  let queryIndex = 0
  for (let index = 0; index < name.length && queryIndex < query.length; index += 1) {
    if (name[index] === query[queryIndex]) queryIndex += 1
  }
  return queryIndex === query.length
}

function sortEntries(entries: FileIndexEntry[], query: string): FileIndexEntry[] {
  return [...entries].sort((left, right) => {
    const leftStarts = left.name.toLowerCase().startsWith(query) ? 0 : 1
    const rightStarts = right.name.toLowerCase().startsWith(query) ? 0 : 1
    if (leftStarts !== rightStarts) return leftStarts - rightStarts
    if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
    return left.path.length - right.path.length || left.name.localeCompare(right.name)
  })
}

function capGroups(
  sessionEntries: FileIndexEntry[],
  workspaceEntries: FileIndexEntry[],
  limit: number,
): { sessionEntries: FileIndexEntry[]; workspaceEntries: FileIndexEntry[] } {
  const safeLimit = Math.max(0, Math.floor(limit))
  if (safeLimit === 0) return { sessionEntries: [], workspaceEntries: [] }
  if (sessionEntries.length + workspaceEntries.length <= safeLimit) return { sessionEntries, workspaceEntries }

  const sessionCount = sessionEntries.length
  const workspaceCount = workspaceEntries.length
  const total = sessionCount + workspaceCount
  let sessionQuota = Math.floor(safeLimit * sessionCount / total)
  let workspaceQuota = safeLimit - sessionQuota

  // 尽量保留两组的代表项，但永远不超过总上限。
  if (sessionCount > 0 && workspaceCount > 0 && safeLimit >= 2) {
    if (sessionQuota === 0) {
      sessionQuota = 1
      workspaceQuota = safeLimit - 1
    } else if (workspaceQuota === 0) {
      workspaceQuota = 1
      sessionQuota = safeLimit - 1
    }
  }

  return {
    sessionEntries: sessionEntries.slice(0, Math.min(sessionQuota, sessionCount)),
    workspaceEntries: workspaceEntries.slice(0, Math.min(workspaceQuota, workspaceCount)),
  }
}

/** 对快照做与主进程一致的匹配/排序，并限制交给 React 的节点数。 */
export function filterFileSnapshot(snapshot: FileSearchResult, query: string, limit = MAX_FILE_MENTION_ITEMS): FileSearchResult {
  const normalizedQuery = query.trim().toLowerCase()
  const sessionMatched = sortEntries(snapshot.sessionEntries.filter((entry) => fuzzyMatch(entry, normalizedQuery)), normalizedQuery)
  const workspaceMatched = sortEntries(snapshot.workspaceEntries.filter((entry) => fuzzyMatch(entry, normalizedQuery)), normalizedQuery)
  const capped = capGroups(sessionMatched, workspaceMatched, limit)
  return {
    entries: [...capped.sessionEntries, ...capped.workspaceEntries],
    total: sessionMatched.length + workspaceMatched.length,
    sessionEntries: capped.sessionEntries,
    workspaceEntries: capped.workspaceEntries,
  }
}

export function limitMentionGroups(
  sessionEntries: FileIndexEntry[],
  workspaceEntries: FileIndexEntry[],
  limit = MAX_FILE_MENTION_ITEMS,
): { sessionEntries: FileIndexEntry[]; workspaceEntries: FileIndexEntry[] } {
  return capGroups(sessionEntries, workspaceEntries, limit)
}

export function limitFileMentionResult(result: FileSearchResult | null, limit = MAX_FILE_MENTION_ITEMS): FileSearchResult {
  if (!result) return { entries: [], total: 0, sessionEntries: [], workspaceEntries: [] }
  const capped = capGroups(result.sessionEntries, result.workspaceEntries, limit)
  return {
    ...result,
    entries: [...capped.sessionEntries, ...capped.workspaceEntries],
    sessionEntries: capped.sessionEntries,
    workspaceEntries: capped.workspaceEntries,
  }
}

/** 只保留最后一次查询的结果；被替换的调用立即完成，底层旧请求即使晚返回也不会更新 UI。 */
export function createLatestQueryRunner<T>(emptyValue: T, delayMs = MENTION_DEBOUNCE_MS) {
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingResolve: ((value: T) => void) | null = null
  let activeResolve: ((value: T) => void) | null = null

  return (operation: () => Promise<T>): Promise<T> => {
    sequence += 1
    const currentSequence = sequence
    if (timer) clearTimeout(timer)
    pendingResolve?.(emptyValue)
    pendingResolve = null
    activeResolve?.(emptyValue)
    activeResolve = null

    return new Promise<T>((resolve) => {
      pendingResolve = resolve
      timer = setTimeout(() => {
        timer = null
        pendingResolve = null
        activeResolve = resolve
        let operationResult: Promise<T>
        try {
          operationResult = operation()
        } catch {
          activeResolve = null
          resolve(emptyValue)
          return
        }
        void operationResult
          .then((value) => {
            if (activeResolve === resolve) activeResolve = null
            resolve(currentSequence === sequence ? value : emptyValue)
          })
          .catch(() => {
            if (activeResolve === resolve) activeResolve = null
            resolve(emptyValue)
          })
      }, delayMs)
    })
  }
}
