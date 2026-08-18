import { basename, isAbsolute, resolve, sep } from 'node:path'
import { readdir, stat } from 'node:fs/promises'

export interface FileSearchRequest {
  requestId: string
  targetName: string
  roots: string[]
  maxDepth: number
  alreadyFound?: string[]
  /** 最多返回的未发现候选数；简单搜索为 1，深度搜索可一次收集多个。 */
  maxResults?: number
  signal?: AbortSignal
}

export interface FileSearchCandidate {
  path: string
}

export interface FileSearchResult {
  requestId: string
  candidate?: FileSearchCandidate
  candidates?: FileSearchCandidate[]
  done: boolean
  cancelled: boolean
}

const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '__pycache__',
  '.venv',
  'build',
  '.cache',
  'target',
])
/** 会话工作目录中的这些隐藏目录承载 Agent 上下文，允许按需搜索。 */
const SEARCHABLE_HIDDEN_DIRECTORIES = new Set(['.claude', '.context'])
const MAX_ENTRIES = 20_000
const YIELD_EVERY = 64

function normalizePath(filePath: string): string {
  const normalized = resolve(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const target = normalizePath(filePath)
  const normalizedRoot = normalizePath(root)
  return target === normalizedRoot || target.startsWith(normalizedRoot + sep)
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise))
}

/**
 * 在主进程授权根目录内异步查找未返回的同名文件。
 * 简单搜索将 maxResults 设为 1；深度搜索可以一次收集多个候选，但始终受目录深度和条目上限约束。
 */
export async function searchFileCandidate(request: FileSearchRequest): Promise<FileSearchResult> {
  const targetName = basename(request.targetName.replace(/[\\/]+/g, sep))
  const targetNameKey = process.platform === 'win32' ? targetName.toLowerCase() : targetName
  const found = new Set((request.alreadyFound ?? []).map(normalizePath))
  const roots = Array.from(new Set(request.roots.filter(Boolean).map(normalizePath)))
  const maxDepth = Math.max(0, Math.min(request.maxDepth, 16))
  const maxResults = Math.max(1, Math.min(request.maxResults ?? 1, 50))
  const matches: string[] = []
  let scannedEntries = 0
  let sinceYield = 0

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (isCancelled(request.signal) || depth > maxDepth || scannedEntries >= MAX_ENTRIES || matches.length >= maxResults) return
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (isCancelled(request.signal) || scannedEntries >= MAX_ENTRIES || matches.length >= maxResults) return
      scannedEntries++
      sinceYield++
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0
        await yieldToEventLoop()
      }
      if (!entry.isFile()) continue
      const entryNameKey = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
      if (entryNameKey !== targetNameKey) continue
      const candidatePath = resolve(directory, entry.name)
      const normalizedCandidate = normalizePath(candidatePath)
      if (!isPathInsideRoot(candidatePath, directory) || found.has(normalizedCandidate)) continue
      try {
        if ((await stat(candidatePath)).isFile()) {
          found.add(normalizedCandidate)
          matches.push(candidatePath)
        }
      } catch {
        // 文件可能在扫描期间被删除，继续搜索其他候选。
      }
    }

    if (depth >= maxDepth) return
    for (const entry of entries) {
      if (isCancelled(request.signal) || scannedEntries >= MAX_ENTRIES || matches.length >= maxResults) return
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue
      if (entry.name.startsWith('.') && !SEARCHABLE_HIDDEN_DIRECTORIES.has(entry.name)) continue
      await walk(resolve(directory, entry.name), depth + 1)
    }
  }

  for (const root of roots) {
    if (isCancelled(request.signal) || matches.length >= maxResults) break
    await walk(root, 0)
  }

  return {
    requestId: request.requestId,
    candidate: matches[0] ? { path: matches[0] } : undefined,
    candidates: matches.map((path) => ({ path })),
    done: true,
    cancelled: isCancelled(request.signal),
  }
}
