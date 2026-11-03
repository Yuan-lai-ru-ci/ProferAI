/**
 * 工作区位置解析器（workspace locator）
 *
 * 唯一职责：把 `slug` 解析成「这个工作区的配置目录在哪 / 项目根在哪 / 属于哪种存储模式」。
 * 所有工作区级路径函数（`config-paths.ts`）都必须经由本模块取值，避免出现两套真相源
 * （历史上有函数手工拼 `agent-workspaces/<slug>`，一旦引入 project 模式就会写错位置）。
 *
 * 硬约束：
 * - 只读：本模块**不创建任何目录**（`rootPath` 尤其不许 mkdir，见不变量 I4）。
 * - 不 import `agent-workspace-manager`：manager 会 import 本模块做缓存失效，
 *   反向引用会形成环。索引文件在此直接读取（`readJsonFileSafe`，不调 manager）。
 * - 不 import `config-paths`：那会形成 `config-paths → locator → config-paths` 的环。
 *   配置根解析下沉在 `config-root.ts`。
 *
 * 存储模式：
 * - `managed`（缺省）：`~/.profer/agent-workspaces/<slug>/`，`rootPath` 与 `configDir` 相同。
 * - `project`：`rootPath` 是用户项目根，`configDir` 是 `<rootPath>/.profer/`。
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentWorkspace, WorkspaceStorageMode } from '@profer/shared'
import { getConfigDir } from './config-root'
import { readJsonFileSafe } from './safe-file'

/** managed 工作区根目录名（全部工作区配置目录的父级）。 */
const WORKSPACES_DIR_NAME = 'agent-workspaces'
/** 工作区索引文件名；`getAgentWorkspacesIndexPath()` 与本模块共用同一常量。 */
const WORKSPACES_INDEX_FILENAME = 'agent-workspaces.json'
/** project 模式下工作区配置目录名（位于项目根之内）。 */
const PROJECT_CONFIG_DIR_NAME = '.profer'

/** 工作区位置三元组。`managed` 下 `rootPath === configDir`。 */
export interface WorkspaceLocation {
  /** 工作区配置目录：managed = `~/.profer/agent-workspaces/<slug>`；project = `<rootPath>/.profer` */
  configDir: string
  /** 项目根：managed 与 configDir 相同；project = 项目根绝对路径（realpath 归一化后） */
  rootPath: string
  /** 会话运行数据根（中央，永不落项目）：managed 与 configDir 相同；project = `~/.profer/agent-workspaces/<slug>` */
  runtimeDir: string
  /** 缺省视为 managed */
  mode: WorkspaceStorageMode
  /**
   * 索引声明这是 project，但 `rootPath` 已缺失/非绝对：位置只能按 managed 解释。
   *
   * 调用方（尤其删除入口）必须把它当「项目绑定已损坏」处理，而不是普通的托管工作区：
   * 该条目的旧布局会话数据仍在中央 runtimeDir 下（新布局在项目内，root 丢失后随项目不可达），
   * 级联删除会真删掉用户的项目会话历史。
   */
  degradedFromProject?: boolean
}

/**
 * 索引条目（含读取期降级标记）。
 *
 * `degradedFromProject` 不属于落盘 schema 的必填字段：它由 `agent-workspace-manager`
 * 在读取到「project 但 rootPath 不可用」时补上，用于阻止删除入口误判为 managed。
 */
export type AgentWorkspaceIndexEntry = AgentWorkspace & {
  degradedFromProject?: boolean
}

/** project 工作区的根目录不存在。刻意不自动创建（I4），由调用方决定如何提示。 */
export class WorkspaceRootMissingError extends Error {
  constructor(public readonly rootPath: string) {
    super(`项目目录不存在，且不会被自动创建: ${rootPath}`)
    this.name = 'WorkspaceRootMissingError'
  }
}

/** managed 工作区根目录（纯路径，不 mkdir）。 */
export function getWorkspacesRootPath(): string {
  return join(getConfigDir(), WORKSPACES_DIR_NAME)
}

/** 工作区索引文件路径（纯路径，不 mkdir）。 */
export function getWorkspacesIndexPath(): string {
  return join(getConfigDir(), WORKSPACES_INDEX_FILENAME)
}

/**
 * rootPath 归一化：存在则 realpath（消除符号链接差异，保证 I5「同一 root 唯一」），
 * 不存在则退化为 `resolve` 的纯字符串归一化（绝不 mkdir）。
 */
export function canonicalizeWorkspaceRootPath(rootPath: string): string {
  try {
    return realpathSync(rootPath)
  } catch {
    return resolve(rootPath)
  }
}

/**
 * 断言 project 工作区根目录存在（只读检查）。
 *
 * managed 工作区直接返回 `rootPath`：它允许在首次使用时由 `getAgentWorkspacePath()` 创建。
 */
export function requireExistingWorkspaceRoot(location: WorkspaceLocation): string {
  if (location.mode === 'project' && !existsSync(location.rootPath)) {
    throw new WorkspaceRootMissingError(location.rootPath)
  }
  return location.rootPath
}

interface IndexSnapshot {
  /** `${mtimeMs}:${size}`，索引被任何写入方改动后自动失效（含 migration-service 直写）。 */
  signature: string
  entries: Map<string, AgentWorkspaceIndexEntry>
}

let snapshot: IndexSnapshot | null = null
const locationCache = new Map<string, WorkspaceLocation>()

function readIndexSignature(indexPath: string): string {
  try {
    const stat = statSync(indexPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 条目是否带有可用作 project 的项目根。
 *
 * 合法 = 非空字符串 + 绝对路径（与 `writeIndex` 的校验一致）。
 */
function hasUsableRootPath(rootPath: unknown): rootPath is string {
  return typeof rootPath === 'string' && rootPath.length > 0 && isAbsolute(rootPath)
}

/** project 工作区的 slug + 归一化 rootPath（供删除守卫使用，不含索引细节）。 */
export interface ProjectWorkspaceRoot {
  slug: string
  rootPath: string
}

/**
 * 只读列出所有 project 工作区的根目录。
 *
 * 供 `workspace-delete-guard.ts` 使用：守卫不能 import `agent-workspace-manager`（会成环），
 * 而跳过索引条目等于放开 I2，所以这里给出一个只读视图。
 * 没有合法 `rootPath` 的条目直接跳过（这类条目按 managed 解释，不涉及项目目录）。
 * 与 `toLocation` 一致：有合法 rootPath 就是 project，不看 `storageMode`（索引损坏时
 * `storageMode` 可能缺失/非法；漏报等于让守卫对真实项目目录失去保护）。
 */
export function listProjectWorkspaceRoots(): ProjectWorkspaceRoot[] {
  const roots: ProjectWorkspaceRoot[] = []
  for (const entry of loadEntries().values()) {
    if (!hasUsableRootPath(entry.rootPath)) continue
    roots.push({ slug: entry.slug, rootPath: canonicalizeWorkspaceRootPath(entry.rootPath) })
  }
  return roots
}

/** Windows 路径比较大小写不敏感；其余平台逐字比较。 */
function sameWorkspacePath(a: string, b: string): boolean {
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

/**
 * 给定路径是否为某个 project 工作区的项目根（realpath 归一化后比较）。
 *
 * 桌面端 `SEARCH_WORKSPACE_FILES` 只能拿到 renderer 提交的 `rootPath`，没有 slug；
 * 用它判断「这次扫描的是项目根」，从而只对 project 工作区剪掉 `.profer` 内部条目。
 * managed 工作区（以及无合法 rootPath 的降级条目）一律返回 false，搜索结果保持原样。
 */
export function isProjectWorkspaceRootPath(rootPath: string): boolean {
  if (typeof rootPath !== 'string' || rootPath.length === 0 || !isAbsolute(rootPath)) return false
  const canonical = canonicalizeWorkspaceRootPath(rootPath)
  return listProjectWorkspaceRoots().some((project) => sameWorkspacePath(project.rootPath, canonical))
}

/**
 * 读取索引条目（只读、容错）。
 *
 * 任何异常都降级为空表：解析不到的 slug 一律按 managed 处理，绝不让路径解析抛错，
 * 否则损坏的索引会连带启动流程一起炸掉。
 */
function loadEntries(): Map<string, AgentWorkspaceIndexEntry> {
  const indexPath = getWorkspacesIndexPath()
  const signature = readIndexSignature(indexPath)
  if (snapshot && snapshot.signature === signature) return snapshot.entries

  const entries = new Map<string, AgentWorkspaceIndexEntry>()
  const data = readJsonFileSafe<{ workspaces?: unknown }>(indexPath)
  if (data && Array.isArray(data.workspaces)) {
    for (const raw of data.workspaces) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as AgentWorkspaceIndexEntry
      if (typeof entry.slug !== 'string' || entry.slug.length === 0) continue
      if (!entries.has(entry.slug)) entries.set(entry.slug, entry)
    }
  }

  snapshot = { signature, entries }
  // 索引内容变了（本进程写入或外部写入），所有已缓存位置作废。
  locationCache.clear()
  return entries
}

function toLocation(slug: string, entry: AgentWorkspaceIndexEntry | undefined): WorkspaceLocation {
  // P1-5：合法绝对 `rootPath` 是 project 的唯一事实来源，`storageMode` 只作辅助。
  // 索引损坏时（storageMode 缺失/非法）若降级 managed，删除入口会级联删掉该项目的全部会话；
  // 因此「有合法 rootPath → project」优先，「没有合法 rootPath → managed」兜底。
  if (entry && hasUsableRootPath(entry.rootPath)) {
    const rootPath = canonicalizeWorkspaceRootPath(entry.rootPath)
    return {
      configDir: join(rootPath, PROJECT_CONFIG_DIR_NAME),
      rootPath,
      runtimeDir: join(getWorkspacesRootPath(), slug),
      mode: 'project',
    }
  }

  // 索引缺失 / 条目无合法 rootPath：位置按 managed 解释（不能猜到项目根），
  // 但如果索引自称 project（或已被读取侧标记降级），必须显式带出 degradedFromProject，
  // 否则删除入口会把它当成普通托管工作区并级联删除会话（P1-残留-2）。
  const degradedFromProject = entry?.degradedFromProject === true || entry?.storageMode === 'project'
  const configDir = join(getWorkspacesRootPath(), slug)
  return {
    configDir,
    rootPath: configDir,
    runtimeDir: configDir,
    mode: 'managed',
    ...(degradedFromProject ? { degradedFromProject: true } : {}),
  }
}

/**
 * 解析工作区位置（进程内缓存）。
 *
 * 只有「索引里确实存在」的条目才会被缓存：创建流程会先建目录、后写索引，
 * 此时解析结果是 managed 兜底，若被固化，同一进程里随后的 project 解析会读到旧结论。
 */
export function resolveWorkspaceLocation(slug: string): WorkspaceLocation {
  // 先校验索引签名：命中缓存也要走这一步，否则外部重写索引后已缓存的 slug 会永远读到旧结论。
  // 签名未变时只付一次 statSync，不会重新解析 JSON。
  loadEntries()

  const cached = locationCache.get(slug)
  if (cached) return cached

  const entry = loadEntries().get(slug)
  const location = toLocation(slug, entry)
  if (entry) locationCache.set(slug, location)
  return location
}

/**
 * 使位置缓存失效。
 *
 * - `invalidateWorkspaceLocation(slug)`：单个工作区（manager 的 create/update/delete 后调用）
 * - `invalidateWorkspaceLocation()`：全部（外部写了索引但不知道具体 slug 时）
 *
 * 同时丢弃索引快照，避免「同尺寸同毫秒重写」被 mtime 签名误判为未变更。
 */
export function invalidateWorkspaceLocation(slug?: string): void {
  snapshot = null
  if (slug === undefined) {
    locationCache.clear()
    return
  }
  locationCache.delete(slug)
}
