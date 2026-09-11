/**
 * Remote Workspace File Search — 远程端（Pocket / 平板）`@` 引用检索
 *
 * 为什么单独存在：
 *  - 桌面端 `@` 引用由 renderer 提交 `rootPath` / `additionalPaths` / `sessionPaths`，
 *    主进程只做本地递归扫描（`ipc.ts` 的 `SEARCH_WORKSPACE_FILES` handler）；
 *  - 远程端没有本地文件系统，且**不允许客户端提交任何授权根**
 *    （与 `remote-file-access.ts` 同一策略），因此 roots 必须由服务端从会话 meta 推导。
 *
 * 语义与桌面端 handler 保持一致（session / workspace 两组、目录优先、同名前缀优先），
 * 以便同一会话在桌面与 Pocket 上看到的 `@` 候选集合相同。
 */

import { basename, relative, resolve } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import type { FileIndexEntry, FileSearchResult } from '@profer/shared'

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.venv',
  'build',
  '.cache',
])
const IGNORE_FILES = new Set([
  '.DS_Store',
  '.Spotlight-V100',
  '.Trashes',
  'Thumbs.db',
  'desktop.ini',
])

const MAX_DEPTH = 10
const BROWSE_LIMIT_PER_GROUP = 2000
const BROWSE_TOTAL_CAP = 3000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

type EntrySource = 'session' | 'workspace'
type Entry = FileIndexEntry

/** 远程检索输入：所有 roots 均由服务端推导，客户端不参与。 */
export interface RemoteWorkspaceFileSearchInput {
  query?: string
  limit?: number
  /** 会话工作目录：条目以相对路径返回（与桌面端 SEARCH_WORKSPACE_FILES 一致）。 */
  sessionRoot: string
  /** 工作区文件目录（workspace files）：绝对路径，条目名对齐桌面的「工作文件」。 */
  workspaceRoot: string
  /** 会话级附加目录 / 附加文件。 */
  sessionAttachedPaths?: readonly string[]
  /** 工作区级附加目录 / 附加文件。 */
  workspaceAttachedPaths?: readonly string[]
}

function scanDirectory(
  dir: string,
  depth: number,
  baseRoot: string,
  target: Entry[],
  useAbsolutePath: boolean,
  source: EntrySource,
): void {
  if (depth > MAX_DEPTH) return
  // 不预先声明类型（readdirSync 重载在 ReturnType 下会选到 Buffer 变体）。
  const items = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      // 无权限 / 已删除的目录直接跳过，不影响其余 roots。
      return null
    }
  })()
  if (!items) return
  for (const item of items) {
    if (IGNORE_FILES.has(item.name)) continue
    if (item.isDirectory() && IGNORE_DIRS.has(item.name)) continue
    const fullPath = resolve(dir, item.name)
    const isDirectory = item.isDirectory()
    target.push({
      name: item.name,
      path: useAbsolutePath ? fullPath : relative(baseRoot, fullPath),
      type: isDirectory ? 'dir' : 'file',
      source,
    })
    if (isDirectory) {
      scanDirectory(fullPath, depth + 1, baseRoot, target, useAbsolutePath, source)
    }
  }
}

/** 附加路径：目录/文件本身作为一条条目（与桌面端 `addAttachedPath` 等价）。 */
function addAttachedPath(pathValue: string, target: Entry[], source: EntrySource): void {
  const attachedPath = resolve(pathValue)
  const name = basename(attachedPath)
  if (!name || IGNORE_FILES.has(name)) return
  let stats
  try {
    stats = statSync(attachedPath)
  } catch {
    return
  }
  if (stats.isFile()) {
    target.push({ name, path: attachedPath, type: 'file', source })
    return
  }
  if (!stats.isDirectory()) return
  if (IGNORE_DIRS.has(name)) return
  target.push({
    name: name === 'workspace-files' ? '工作文件' : name,
    path: attachedPath,
    type: 'dir',
    source,
  })
  scanDirectory(attachedPath, 0, attachedPath, target, true, source)
}

/**
 * 扫描会话授权根内的文件条目。
 *
 * 授权边界与 `remote-service` 的 `read_file_as_data_url` 同源：
 * 会话工作目录 + 工作区文件目录 + 会话/工作区附加目录与附加文件。
 * 不读取、也不接受调用方提交的任意路径。
 */
export function searchRemoteWorkspaceFiles(input: RemoteWorkspaceFileSearchInput): FileSearchResult {
  const sessionEntries: Entry[] = []
  const workspaceEntries: Entry[] = []

  // session 分组：相对路径（与桌面端一致）
  scanDirectory(resolve(input.sessionRoot), 0, resolve(input.sessionRoot), sessionEntries, false, 'session')
  for (const attached of input.sessionAttachedPaths ?? []) {
    addAttachedPath(attached, sessionEntries, 'session')
  }

  // workspace 分组：绝对路径（工作区文件目录 + 工作区级附加目录/文件）
  if (input.workspaceRoot) {
    addAttachedPath(input.workspaceRoot, workspaceEntries, 'workspace')
  }
  for (const attached of input.workspaceAttachedPaths ?? []) {
    addAttachedPath(attached, workspaceEntries, 'workspace')
  }

  const limit = Math.max(1, Math.min(
    typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : DEFAULT_LIMIT,
    MAX_LIMIT,
  ))
  const query = (input.query ?? '').toLowerCase()

  if (!query) {
    // 空 query：目录优先排序后再截断，保证文件夹结构完整可见。
    sortDirsFirst(sessionEntries)
    sortDirsFirst(workspaceEntries)
    const maxPerGroup = Math.max(limit, BROWSE_LIMIT_PER_GROUP)
    const sessionSlice = sessionEntries.slice(0, maxPerGroup)
    const workspaceSlice = workspaceEntries.slice(0, maxPerGroup)
    const combined = [...sessionSlice, ...workspaceSlice]
    const capped = combined.length > BROWSE_TOTAL_CAP ? combined.slice(0, BROWSE_TOTAL_CAP) : combined
    return {
      entries: capped,
      total: sessionEntries.length + workspaceEntries.length,
      sessionEntries: sessionSlice,
      workspaceEntries: workspaceSlice,
    }
  }

  const sessionMatched = matchEntries(sessionEntries, query)
  const workspaceMatched = matchEntries(workspaceEntries, query)
  sortGroup(sessionMatched, query)
  sortGroup(workspaceMatched, query)

  const totalMatched = sessionMatched.length + workspaceMatched.length
  if (totalMatched <= limit) {
    return {
      entries: [...sessionMatched, ...workspaceMatched],
      total: totalMatched,
      sessionEntries: sessionMatched,
      workspaceEntries: workspaceMatched,
    }
  }

  const sessionQuota = Math.max(
    sessionMatched.length > 0 ? 1 : 0,
    Math.round(limit * sessionMatched.length / totalMatched),
  )
  const workspaceQuota = Math.max(workspaceMatched.length > 0 ? 1 : 0, limit - sessionQuota)
  const sessionSlice = sessionMatched.slice(0, sessionQuota)
  const workspaceSlice = workspaceMatched.slice(0, workspaceQuota)

  return {
    entries: [...sessionSlice, ...workspaceSlice],
    total: totalMatched,
    sessionEntries: sessionSlice,
    workspaceEntries: workspaceSlice,
  }
}

/** 组内排序：前缀匹配优先，目录优先，路径短优先。 */
function sortGroup(entries: Entry[], query: string): void {
  entries.sort((a, b) => {
    const aStartsWith = a.name.toLowerCase().startsWith(query) ? 0 : 1
    const bStartsWith = b.name.toLowerCase().startsWith(query) ? 0 : 1
    if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.path.length - b.path.length
  })
}

/** 与桌面端相同的匹配口径：前缀 / 子串 / 子序列。 */
function matchEntries(entries: Entry[], query: string): Entry[] {
  return entries.filter((entry) => {
    const nameLower = entry.name.toLowerCase()
    const pathLower = entry.path.toLowerCase()
    if (nameLower.startsWith(query)) return true
    if (nameLower.includes(query) || pathLower.includes(query)) return true
    let queryIndex = 0
    for (let i = 0; i < nameLower.length && queryIndex < query.length; i++) {
      if (nameLower[i] === query[queryIndex]) queryIndex++
    }
    return queryIndex === query.length
  })
}

/** 目录优先排序：确保截断前所有目录（特别是顶层目录）排在前面。 */
function sortDirsFirst(entries: Entry[]): void {
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.path.length - b.path.length || a.name.localeCompare(b.name)
  })
}
