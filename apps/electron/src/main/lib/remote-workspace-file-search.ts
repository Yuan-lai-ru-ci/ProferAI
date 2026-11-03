/**
 * Remote Workspace File Search — 移动端（Pocket）`@` 引用检索
 *
 * 为什么单独存在：
 *  - 桌面端 `@` 引用由 renderer 提交 `rootPath` / `additionalPaths` / `sessionPaths`，
 *    主进程只做本地递归扫描（`ipc.ts` 的 `SEARCH_WORKSPACE_FILES` handler）；
 *  - 远程端没有本地文件系统，且**不允许客户端提交任何授权根**
 *    （与 `remote-file-access.ts` 同一策略），因此 roots 必须由服务端从会话 meta 推导。
 *
 * 语义与桌面端 handler 保持一致（session / workspace 两组、目录优先、同名前缀优先），
 * 以便同一会话在桌面与 Pocket 上看到的 `@` 候选集合相同。
 *
 * 例外：project 工作区的 `sessionRoot` 就是项目根，扫描时会剪掉 `<root>/.profer` 下的
 * Profer 内部条目（`presets/`、`skills/`、`sessions/`、`cache/` 等），只保留 `profile.md`、
 * `memory/`、`workspace-files/` 这类用户会主动引用的内容。managed 不剪，结果逐字不变。
 *
 * 桌面端（`ipc.ts` 的 `SEARCH_WORKSPACE_FILES`）与远端共用本文件的 `scanWorkspaceRoot`
 * 与 `shouldSkipProjectInternalEntry`，避免两端 `@` 可见集合再次漂移。
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

/** project 工作区的配置目录名（位于项目根下）。 */
const PROJECT_CONFIG_DIR_NAME = '.profer'

/**
 * project 模式下 `<root>/.profer` 里不对用户暴露的内部条目。
 *
 * 这些是 Profer 自己的状态（岗位/技能/会话/缓存/MCP 配置），在 `@` 引用里既无用
 * 又会泄露内部结构；`profile.md`、`memory/`、`workspace-files/` 不在集合里，保留。
 * 只作用于 `.profer` 这一层，项目自身同名目录（如 `docs/presets/`）不受影响。
 */
export const PROJECT_INTERNAL_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'presets',
  'skills',
  'skills-inactive',
  'sessions',
  'cache',
  '.claude-plugin',
  'config.json',
  'mcp.json',
  'mcp.local.json',
])

type EntrySource = 'session' | 'workspace'
type Entry = FileIndexEntry

/**
 * project 模式下不向用户暴露的 `.profer` 内部条目谓词。
 *
 * 桌面端 `SEARCH_WORKSPACE_FILES` 与远端搜索共用这一份判据：只在扫描目录**正好是**
 * `<root>/.profer` 这一层时剪掉内部条目；`profile.md`、`memory/`、`workspace-files/`
 * 不在集合里，所以保留。`projectInternalDir` 为 undefined 时恒为 false（managed 逐字不变）。
 */
export function shouldSkipProjectInternalEntry(
  dir: string,
  name: string,
  projectInternalDir: string | undefined,
): boolean {
  if (!projectInternalDir) return false
  if (!samePath(resolve(dir), projectInternalDir)) return false
  return PROJECT_INTERNAL_ENTRY_NAMES.has(name)
}

/** project 工作区里 `<root>/.profer` 的绝对路径（仅由 project 根推导，不做存在性检查）。 */
export function resolveProjectInternalEntryDir(rootPath: string): string {
  return resolve(rootPath, PROJECT_CONFIG_DIR_NAME)
}

/**
 * 通用目录递归扫描（桌面端与远端共用）。
 *
 * 返回目录下的全部条目（不含 `dir` 自身），行为与原桌面端 `scan()` 逐字一致：
 * 忽略目录/忽略文件、最大深度 10、相对路径基于 `baseRoot`。
 * `projectInternalDir` 只影响该目录这一层的 `.profer` 内部条目剪枝。
 */
export interface ScanWorkspaceRootOptions {
  /** 相对路径的基准（通常是调用方传入的根目录）。 */
  baseRoot: string
  /** true：返回绝对路径（附加目录）；false：返回相对路径（会话根）。 */
  useAbsolutePath: boolean
  source: EntrySource
  /** project 模式下 `<root>/.profer` 的绝对路径；无此参数则不做 `.profer` 剪枝。 */
  projectInternalDir?: string
}

export function scanWorkspaceRoot(root: string, options: ScanWorkspaceRootOptions): Entry[] {
  const entries: Entry[] = []
  scanDirectoryInto(root, 0, options, entries)
  return entries
}

function scanDirectoryInto(
  dir: string,
  depth: number,
  options: ScanWorkspaceRootOptions,
  target: Entry[],
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
    if (shouldSkipProjectInternalEntry(dir, item.name, options.projectInternalDir)) continue
    const fullPath = resolve(dir, item.name)
    const isDirectory = item.isDirectory()
    target.push({
      name: item.name,
      path: options.useAbsolutePath ? fullPath : relative(options.baseRoot, fullPath),
      type: isDirectory ? 'dir' : 'file',
      source: options.source,
    })
    if (isDirectory) {
      scanDirectoryInto(fullPath, depth + 1, options, target)
    }
  }
}

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
  /**
   * 是否为 project 工作区（`sessionRoot` 即项目根）。
   *
   * 开启后会在扫描时剪掉 `<sessionRoot>/.profer` 下的 Profer 内部条目
   * （`presets/`、`skills/`、`sessions/`、`cache/` 等），保留 `profile.md` / `memory/` /
   * `workspace-files/`。managed 不传，扫描结果逐字不变。
   */
  isProjectWorkspace?: boolean
}

/** 同一路径比较；Windows 大小写不敏感。 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

function scanDirectory(
  dir: string,
  baseRoot: string,
  target: Entry[],
  useAbsolutePath: boolean,
  source: EntrySource,
  /** project 模式下 `<项目根>/.profer` 的绝对路径；命中时剪掉内部条目 */
  projectInternalDir?: string,
): void {
  target.push(...scanWorkspaceRoot(dir, {
    baseRoot,
    useAbsolutePath,
    source,
    projectInternalDir,
  }))
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
  scanDirectory(attachedPath, attachedPath, target, true, source)
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

  // session 分组：相对路径（与桌面端一致）；project 额外剪掉 `.profer` 内部条目。
  const resolvedSessionRoot = resolve(input.sessionRoot)
  const projectInternalDir = input.isProjectWorkspace
    ? resolve(resolvedSessionRoot, PROJECT_CONFIG_DIR_NAME)
    : undefined
  scanDirectory(resolvedSessionRoot, resolvedSessionRoot, sessionEntries, false, 'session', projectInternalDir)
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
