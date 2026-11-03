/**
 * Agent 工作区管理器
 *
 * 负责 Agent 工作区的 CRUD 操作。
 * - 工作区索引：~/.profer/agent-workspaces.json（轻量元数据）
 * - 工作区目录：~/.profer/agent-workspaces/{slug}/（Agent 的 cwd）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, rmSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import { listGlobalSkills, setGlobalSkillEnabled, copySkillDirectorySafely, createUserGlobalSkill, LEDGER_FILENAMES } from './global-skill-manager'
import { join, resolve, relative, isAbsolute, dirname, basename, parse } from 'node:path'
import {
  getAgentWorkspacesIndexPath,
  getAgentWorkspacesDir,
  getAgentWorkspacePath,
  getConfigDir,
  resolveWorkspaceFilesDir,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir,
  getInactiveSkillsDir,
  parseSkillVersion,
} from './config-paths'
import { findAllGitRoots, normalizeGitRoot } from './git-diff-service'
import { assertSafeSkillSegment, canonicalSkillSegmentKey } from './skill-path-security'
import { readSkillManifest, writeSkillManifest } from './skill-manifest'
import { diagnoseSkill } from './skill-doctor'
import { deleteAgentSessionsByWorkspace } from './agent-session-manager'
import { listAgentPresets, createAgentPreset } from './agent-preset-manager'
import { canonicalizeWorkspaceRootPath, invalidateWorkspaceLocation, resolveWorkspaceLocation, type AgentWorkspaceIndexEntry } from './workspace-locator'
import { assertNotProjectLifecyclePath } from './workspace-delete-guard'
import type { AgentWorkspace, WorkspaceMcpConfig, McpServerEntry, SkillMeta, SkillImportSource, WorkspaceSkillSource, OtherWorkspaceSkillsGroup, OtherWorkspacePresetsGroup, WorkspaceSkillCardState, SkillManifestPatch, WorkspaceCapabilities, SkillFileNode, SkillFileContent, WorkspaceMemorySummary, AgentPreset, CreateProjectWorkspaceInput, OpenProjectWorkspaceInput, ProjectWorkspaceOpenResult, ProjectWorkspaceErrorCode } from '@profer/shared'

interface AgentWorkspacesIndex {
  version: number
  workspaces: AgentWorkspaceIndexEntry[]
}

/**
 * 索引版本
 *
 * v4 新增 `storageMode`（缺省语义 = managed）与 `rootPath`（仅 project 落盘）。
 */
const INDEX_VERSION = 4

/**
 * 归一化索引条目（P1-5 / P1-残留-2）：合法绝对 `rootPath` 是 project 的唯一事实来源。
 *
 * - 有合法 `rootPath`：即使 `storageMode` 缺失/非法也判为 project，并补写 `storageMode: 'project'`。
 *   降级成 managed 会让「移除/删除」走级联分支，真删掉该项目的全部会话历史（P1-5）。
 *   写入侧 `validateIndexBeforeWrite` 本就禁止 managed 带 `rootPath`，所以带 rootPath 的条目
 *   几乎只可能是「project 条目的 storageMode 被外部工具/旧版本抹掉」。
 * - `storageMode === 'project'` 但 `rootPath` 缺失/非绝对：索引已损坏，无法恢复项目根。
 *   仍保留 `storageMode: 'project'`（写入校验对带降级标记的条目放行），并补上
 *   `degradedFromProject: true`：UI 会显示「重新定位」，删除入口据此只删索引、保留会话。
 * - 其余（正常 managed）：按 managed 处理，行为逐字不变（I1）。
 */
function normalizeWorkspaceEntry(entry: AgentWorkspaceIndexEntry): AgentWorkspaceIndexEntry {
  const hasUsableRoot = hasUsableRootPath(entry.rootPath)

  if (hasUsableRoot) {
    if (entry.storageMode !== 'project') {
      console.warn(
        `[Agent 工作区] 索引条目有 rootPath 但 storageMode 缺失/非法，已按 project 处理: ${entry.slug ?? entry.id ?? '(unknown)'}`,
      )
      entry.storageMode = 'project'
    }
    // 项目根重新可用了：降级状态解除
    delete entry.degradedFromProject
    return entry
  }

  // project 但 rootPath 缺失/非绝对：索引已损坏，不能静默当成普通 managed。
  // 位置解析仍只能按 managed（见 workspace-locator 的 degradedFromProject），
  // 但 storageMode 保持 project：
  //   - IPC 删除入口据此走「只移除绑定」分支，不会先删会话再删索引；
  //   - UI 已有的「project 缺 rootPath → 重新定位」逻辑可以直接生效。
  if (entry.storageMode === 'project' || entry.degradedFromProject === true) {
    console.warn(
      `[Agent 工作区] 索引条目为 project 但 rootPath 缺失/非绝对，已标记降级（会话与磁盘均保留）: ${entry.slug ?? entry.id ?? '(unknown)'}`,
    )
    entry.storageMode = 'project'
    entry.degradedFromProject = true
    delete entry.rootPath
    return entry
  }

  // 普通 managed 条目：清除可能存在的非法 rootPath / 降级标记，保证写入校验可通过。
  if (entry.rootPath !== undefined) {
    console.warn(`[Agent 工作区] 索引条目存储模式无效，已按 managed 处理: ${entry.slug ?? entry.id ?? '(unknown)'}`)
  }
  entry.storageMode = 'managed'
  delete entry.rootPath
  delete entry.degradedFromProject
  return entry
}

/** 合法项目根：非空字符串 + 绝对路径（与 `validateIndexBeforeWrite` 同一判据）。 */
function hasUsableRootPath(rootPath: unknown): rootPath is string {
  return typeof rootPath === 'string' && rootPath.length > 0 && isAbsolute(rootPath)
}

/** 读取并归一化索引（永不 throw） */
function normalizeIndex(data: unknown): AgentWorkspacesIndex {
  if (!data || typeof data !== 'object') return { version: INDEX_VERSION, workspaces: [] }

  const raw = data as Partial<AgentWorkspacesIndex>
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1

  if (!Array.isArray(raw.workspaces)) {
    console.error('[Agent 工作区] 索引 workspaces 不是数组，已回退为空列表')
    return { version: INDEX_VERSION, workspaces: [] }
  }

  const workspaces: AgentWorkspace[] = []
  for (const entry of raw.workspaces) {
    if (!entry || typeof entry !== 'object') continue
    workspaces.push(normalizeWorkspaceEntry(entry as AgentWorkspaceIndexEntry))
  }

  return { version, workspaces }
}

/** 读取工作区索引文件，自动执行版本迁移 */
/** @internal 供同步/团队管理器使用，普通调用方用 listAgentWorkspaces() */
export function readIndex(): AgentWorkspacesIndex {
  const indexPath = getAgentWorkspacesIndexPath()
  const index = normalizeIndex(readJsonFileSafe<unknown>(indexPath))

  // 版本迁移（幂等，顺序执行）。迁移写盘失败不能让读路径抛错：
  // 调用方要的是一份可用的工作区列表，而不是二次崩。
  if (index.version < INDEX_VERSION) {
    try {
      migrateIndex(index, index.version)
    } catch (error) {
      console.warn('[Agent 工作区] 索引迁移失败，本次使用内存中的归一化结果:', error)
    }
  }

  return index
}

function migrateIndex(index: AgentWorkspacesIndex, oldVersion: number): void {
  // v1 → v2: 为所有工作区默认启用 skill-creator
  if (oldVersion < 2) {
    activateSkillCreatorInAllWorkspaces(index)
  }

  // v2 → v3: 为所有工作区添加 type 字段（向后兼容）
  if (oldVersion < 3) {
    for (const workspace of index.workspaces) {
      if (!workspace.type) {
        workspace.type = 'personal'
      }
    }
  }

  // v3 → v4: 存量条目补 storageMode；带合法 rootPath 的条目一律保持 project（P1-5：
  // 不能把 rootPath 删掉，否则删除入口会把 project 当 managed 级联删会话）
  if (oldVersion < 4) {
    for (const workspace of index.workspaces) {
      if (hasUsableRootPath(workspace.rootPath)) {
        workspace.storageMode = 'project'
        delete workspace.degradedFromProject
        continue
      }
      // 索引自称 project 但没有可用的 rootPath：保持 project + 降级标记，
      // 否则迁移会把损坏条目洗成 managed，删除时又级联删会话。
      if (workspace.storageMode === 'project' || workspace.degradedFromProject === true) {
        workspace.storageMode = 'project'
        workspace.degradedFromProject = true
        delete workspace.rootPath
        continue
      }
      workspace.storageMode = 'managed'
      delete workspace.rootPath
    }
  }

  index.version = INDEX_VERSION
  writeIndex(index)
  // 迁移改变了 storageMode，已缓存的工作区位置必须作废
  invalidateWorkspaceLocation()
  console.log(`[Agent 工作区] 索引已迁移: v${oldVersion} → v${INDEX_VERSION}`)
}

/** v1→v2 迁移：将 skills-inactive/skill-creator 移到 skills/ */
function activateSkillCreatorInAllWorkspaces(index: AgentWorkspacesIndex): void {
  for (const workspace of index.workspaces) {
    const activeDir = getWorkspaceSkillsDir(workspace.slug)
    const inactiveDir = getInactiveSkillsDir(workspace.slug)

    const inactivePath = join(inactiveDir, 'skill-creator')
    const activePath = join(activeDir, 'skill-creator')

    if (existsSync(activePath) || !existsSync(inactivePath)) continue

    try {
      if (!existsSync(activeDir)) {
        mkdirSync(activeDir, { recursive: true })
      }
      renameSync(inactivePath, activePath)
      console.log(`[Agent 工作区] 已为 ${workspace.slug} 启用 skill-creator`)
    } catch (err) {
      console.warn(`[Agent 工作区] 启用 skill-creator 失败 (${workspace.slug}):`, err)
    }
  }
}

/**
 * 写入前校验（I5/I6）：
 * - project 必须有绝对 rootPath（唯一例外：读取侧已标记 `degradedFromProject` 的损坏条目，
 *   它没有可校验的项目根，只允许原样落盘/移除）；
 * - managed 不得携带 rootPath；
 * - rootPath 经 realpath（不存在时 resolve）归一化后唯一。
 *
 * 校验通过后就地把 rootPath 写回归一化结果，保证磁盘上的值与唯一性判据一致。
 */
function validateIndexBeforeWrite(index: AgentWorkspacesIndex): void {
  if (!Array.isArray(index.workspaces)) {
    throw new Error('工作区索引 workspaces 必须是数组')
  }

  const owners = new Map<string, string>()
  for (const workspace of index.workspaces) {
    const label = workspace.name ?? workspace.slug ?? workspace.id ?? '(unknown)'
    const mode: string | undefined = workspace.storageMode

    if (mode === 'project') {
      const rootPath = workspace.rootPath
      if (typeof rootPath !== 'string' || rootPath.length === 0 || !isAbsolute(rootPath)) {
        // P1-残留-2：project 条目丢失 rootPath 是「已损坏但必须保留会话」的状态，
        // 由读取侧打上 degradedFromProject；它没有可校验的项目根，只允许原样落盘。
        if (workspace.degradedFromProject === true) continue
        throw new Error(`project 工作区必须有绝对 rootPath: ${label}`)
      }
      const canonical = canonicalizeWorkspaceRootPath(rootPath)
      const existing = owners.get(canonical)
      if (existing && existing !== workspace.slug) {
        throw new Error(`项目目录已被其他工作区使用: ${canonical}`)
      }
      owners.set(canonical, workspace.slug)
      workspace.rootPath = canonical
      continue
    }

    if (mode !== undefined && mode !== 'managed') {
      throw new Error(`未知的工作区存储模式: ${String(mode)} (${label})`)
    }
    if (workspace.rootPath !== undefined) {
      throw new Error(`managed 工作区不得包含 rootPath: ${label}`)
    }
  }
}

/**
 * 写入前的模式归一化（P1-5）：有合法 `rootPath` 但 `storageMode` 缺失/非法的条目补写成 `project`。
 *
 * 只补写缺失/非法值，不替调用方掩盖「显式 managed + rootPath」这种自相矛盾的编程错误：
 * 后者继续由 `validateIndexBeforeWrite` 拒绝（read 侧已把带 rootPath 的条目归一成 project）。
 */
function normalizeIndexBeforeWrite(index: AgentWorkspacesIndex): void {
  for (const workspace of index.workspaces) {
    if (workspace.storageMode === 'project') continue
    if (!hasUsableRootPath(workspace.rootPath)) continue
    if (workspace.storageMode === 'managed') continue
    workspace.storageMode = 'project'
  }
}

/** @internal 供同步/团队管理器使用 */
export function writeIndex(index: AgentWorkspacesIndex): void {
  const indexPath = getAgentWorkspacesIndexPath()

  // P1-5：先把「有 rootPath 但 storageMode 缺失/非法」的条目归一成 project，再校验
  normalizeIndexBeforeWrite(index)

  // 校验失败直接抛错（属于写入方的编程错误，不能被当成 IO 失败吞掉）
  validateIndexBeforeWrite(index)

  // 溯源保护：收纳标记是纯本地状态，任何写入都不应该把它静默抹掉。
  // 如果即将写入的内容相比磁盘少了 archived，先把调用栈打出来，
  // 否则这种丢失只会在重启后表现成“收纳莫名失效”，事后无法定位。
  try {
    const onDisk = readJsonFileSafe<AgentWorkspacesIndex>(indexPath)
    if (onDisk && Array.isArray(onDisk.workspaces)) {
      for (const previous of onDisk.workspaces) {
        if (!previous.archived) continue
        const next = index.workspaces.find((w) => w.id === previous.id)
        if (next && !next.archived) {
          console.warn(
            `[Agent 工作区] 写入即将丢失收纳标记: ${previous.name ?? previous.slug} (${previous.id})\n${new Error().stack ?? ''}`,
          )
        }
      }
    }
  } catch {
    // 溯源检测失败不影响正常写入
  }

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[Agent 工作区] 写入索引文件失败:', error)
    throw new Error('写入 Agent 工作区索引失败')
  }
}

/** 名称转 URL-safe slug，非 ASCII 名称 fallback 为 workspace-{timestamp} */
function slugify(name: string, existingSlugs: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  if (!base) {
    base = `workspace-${Date.now()}`
  }

  try { assertSafeSkillSegment(base, 'workspaceSlug') } catch { base = `workspace-${base}` }

  let slug = base
  let counter = 1
  while (existingSlugs.has(canonicalSkillSegmentKey(slug))) {
    slug = `${base}-${counter}`
    counter++
  }

  return slug
}

/** 返回索引中的存储顺序（与 UI 拖拽顺序一致）；返回副本，避免调用方 sort 等操作误改索引数组 */

export function listAgentWorkspaces(): AgentWorkspace[] {
  const index = readIndex()
  return index.workspaces.slice()
}

/** 按 updatedAt 降序（桥接/飞书列表等与旧版内联 sort 一致；渲染进程仍用 listAgentWorkspaces） */
export function listAgentWorkspacesByUpdatedAt(): AgentWorkspace[] {
  const index = readIndex()
  return index.workspaces.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 按指定 ID 顺序重排工作区，未列出的追加到末尾 */
export function reorderAgentWorkspaces(orderedIds: string[]): AgentWorkspace[] {
  const index = readIndex()
  const byId = new Map(index.workspaces.map((w) => [w.id, w]))
  const reordered: AgentWorkspace[] = []
  for (const id of orderedIds) {
    const ws = byId.get(id)
    if (ws) {
      reordered.push(ws)
      byId.delete(id)
    }
  }
  for (const ws of byId.values()) reordered.push(ws)
  index.workspaces = reordered
  writeIndex(index)
  return reordered
}

export function getAgentWorkspace(id: string): AgentWorkspace | undefined {
  const index = readIndex()
  return index.workspaces.find((w) => w.id === id)
}

export function createAgentWorkspace(
  name: string,
  opts?: { type?: 'personal' },
): AgentWorkspace {
  const index = readIndex()

  const duplicate = index.workspaces.find((w) => w.name === name)
  if (duplicate) {
    throw new Error(`工作区名称「${name}」已存在`)
  }

  const existingSlugs = new Set(index.workspaces.map((w) => canonicalSkillSegmentKey(w.slug)))
  const slug = slugify(name, existingSlugs)
  const now = Date.now()

  const workspace: AgentWorkspace = {
    id: randomUUID(),
    name,
    slug,
    createdAt: now,
    updatedAt: now,
    type: opts?.type ?? 'personal',
  }

  try {
    getAgentWorkspacePath(slug)
    ensurePluginManifest(slug, name)
  } catch (error) {
    const workspacesRoot = resolve(getAgentWorkspacesDir())
    const workspaceDir = resolve(join(workspacesRoot, slug))
    const relativePath = relative(workspacesRoot, workspaceDir)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) && existsSync(workspaceDir)) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true })
      } catch (cleanupError) {
        console.warn(`[Agent 工作区] 创建失败后清理目录失败 (${slug}):`, cleanupError)
      }
    }
    console.error(`[Agent 工作区] 创建工作区失败 (${name}, slug: ${slug}):`, error)
    throw new Error(`创建项目失败: ${(error as Error)?.message ?? '初始化项目目录失败'}`)
  }

  index.workspaces.unshift(workspace)
  writeIndex(index)
  // 新工作区的目录已建好，位置缓存必须作废（本次解析可能命中了 managed 兜底）
  invalidateWorkspaceLocation(slug)

  console.log(`[Agent 工作区] 已创建个人工作区: ${name} (slug: ${slug})`)
  return workspace
}

/** 更新工作区名称或收纳状态（slug 和目录不变） */
export function updateAgentWorkspace(
  id: string,
  updates: { name?: string; archived?: boolean },
): AgentWorkspace {
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === id)

  if (idx === -1) {
    throw new Error(`Agent 工作区不存在: ${id}`)
  }

  const existing = index.workspaces[idx]!
  const nextName = updates.name ?? existing.name

  // 仅在实际改名时做重名校验，避免收纳/取出被同名逻辑误伤
  if (updates.name !== undefined) {
    const duplicate = index.workspaces.find((w) => w.id !== id && w.name === nextName)
    if (duplicate) {
      throw new Error(`工作区名称「${nextName}」已存在`)
    }
  }

  let archived = existing.archived
  let archivedAt = existing.archivedAt
  if (updates.archived !== undefined) {
    if (updates.archived) {
      if (existing.slug === 'default') {
        throw new Error('默认工作区不能收纳')
      }
      // 重复收纳保持首次时间戳，避免刷新排序
      archivedAt = existing.archived ? existing.archivedAt : Date.now()
      archived = true
    } else {
      archived = false
      archivedAt = undefined
    }
  }

  const updated: AgentWorkspace = {
    ...existing,
    updatedAt: Date.now(),
  }

  // 只改归档状态时完全不触碰 name：读-改-写循环里不能把未提供的字段写成 undefined，
  // 否则历史数据中缺失 name 的工作区会把键抹掉（旧实现无条件写 name 就漏过这个坑）。
  if (updates.name !== undefined) {
    updated.name = nextName
  }

  // 显式维护归档字段：未收纳时不落盘，保持索引文件干净
  if (archived) {
    updated.archived = true
    updated.archivedAt = archivedAt
  } else {
    delete updated.archived
    delete updated.archivedAt
  }

  index.workspaces[idx] = updated
  writeIndex(index)
  // 名称/收纳不影响路径，但 storageMode 与 rootPath 属于索引事实：保守作废缓存
  invalidateWorkspaceLocation(existing.slug)

  const archiveNote =
    updates.archived === undefined ? '' : archived ? ' [已收纳]' : ' [已取出]'
  console.log(`[Agent 工作区] 已更新工作区: ${updated.name} (${updated.id})${archiveNote}`)
  return updated
}

/** 删除工作区索引条目及其本地目录 */
export function deleteAgentWorkspace(id: string): void {
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === id)

  if (idx === -1) {
    throw new Error(`Agent 工作区不存在: ${id}`)
  }

  const target = index.workspaces[idx]!
  if (target.slug === 'default') {
    throw new Error('默认项目不能删除')
  }
  if (index.workspaces.length <= 1) {
    throw new Error('至少需要保留一个项目')
  }

  // ── project / 降级 project：移除绑定 = 只删索引（设计 §6.3 / I2）──
  // 必须在任何级联清理与工作区派生路径计算之前分流：
  //   - 不调 deleteAgentSessionsByWorkspace（会话记录保留，仍可按 sessionId 访问）
  //   - 不 rmSync / renameSync / mkdirSync（rootPath 与 <rootPath>/.profer 都不碰）
  // 降级条目（project 但 rootPath 丢失）同样只删索引：会话数据在中央 runtimeDir，
  // 按 managed 级联会真删掉用户的项目会话历史（P1-残留-2）。
  if (target.storageMode === 'project' || target.degradedFromProject === true) {
    if (target.degradedFromProject === true) {
      console.warn(
        `[Agent 工作区] 索引条目为 project 但缺少有效 rootPath，仅移除索引，会话历史已保留: ${target.name} (slug: ${target.slug})`,
      )
    }
    removeProjectIndexEntry(index, target, 'delete')
    return
  }

  const workspacesRoot = resolve(getAgentWorkspacesDir())
  const workspaceDir = resolve(join(workspacesRoot, target.slug))
  const relativePath = relative(workspacesRoot, workspaceDir)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`工作区目录路径异常，已跳过删除: ${workspaceDir}`)
  }

  // managed 兜底：若 slug 恰好撞上某个 project 的 rootPath（索引异常 / 人为写脏），
  // 必须在级联清理与 rmSync 之前就拦截，绝不递归删项目。
  assertNotProjectLifecyclePath(workspaceDir)

  // 防御性级联清理：删除仍指向该工作区的会话（索引 + 消息/任务图文件 + session 目录 + SDK 数据）。
  // 正常流程由 ipc DELETE_WORKSPACE handler 先行删除（含停止运行中 Agent、清理运行时状态），
  // 这里兜底防止其他调用路径绕过后残留孤儿会话 —— 孤儿会话会让移动端把 workspaceId
  // 归纳成“幽灵项目”显示（electronapi-stub 的 list_workspaces 回退路径）。
  // 注意：必须在移除索引条目之前执行，deleteAgentSession 需要依赖工作区解析 session 工作目录。
  try {
    deleteAgentSessionsByWorkspace(id)
  } catch (error) {
    console.warn(`[Agent 工作区] 级联清理会话失败 (${target.slug}):`, error)
  }

  // 先移除索引条目并落盘，再删目录：
  // 即使随后 rmSync 失败，也只会残留一个无引用目录（无害，可被同 slug 重建覆盖），
  // 而不会留下指向已删目录的孤儿索引条目导致 UI 状态不一致
  const removed = index.workspaces.splice(idx, 1)[0]!
  writeIndex(index)
  // 索引里已经没有该 slug：缓存必须作废，否则后续解析会拿到指向已删目录的旧结论
  invalidateWorkspaceLocation(target.slug)

  if (existsSync(workspaceDir)) {
    try {
      rmSync(workspaceDir, { recursive: true, force: true })
      console.log(`[Agent 工作区] 已删除工作区目录: ${workspaceDir}`)
    } catch (error) {
      console.warn(`[Agent 工作区] 删除工作区目录失败，已残留无引用目录 (${target.slug}):`, error)
    }
  }

  console.log(`[Agent 工作区] 已删除工作区: ${removed.name} (slug: ${removed.slug})`)
}

// ===== 项目模式：创建 / 打开 / 移除（设计 §6.1–§6.3） =====

/** project 模式配置目录名：固定 `.profer`，不随配置根变化。 */
const PROJECT_CONFIG_DIR_NAME = '.profer'
/** 项目清单文件名（位于 `.profer/` 内）。 */
const PROJECT_MANIFEST_FILE = 'profer.json'
/** 项目清单 schema 主版本。 */
const PROJECT_MANIFEST_SCHEMA = 'profer.project/1'
const PROJECT_MANIFEST_SCHEMA_PREFIX = 'profer.project/'
/** `.profer/presets/_config.json` 的空结构：不预生成任何岗位文件。 */
const PROJECT_PRESETS_CONFIG = {
  schema: 'profer.presets/1',
  defaultPresetReference: null,
  defaultPresetExplicitlyCleared: false,
  disabledGlobalPresetIds: [] as string[],
  disabledWorkspacePresetIds: [] as string[],
}
/** `.profer/.gitignore`：会话、缓存、产物区与本机覆盖层都不提交。 */
const PROJECT_GITIGNORE_CONTENT = ['sessions/', 'cache/', 'workspace-files/', '*.local.json', '.lock', ''].join('\n')
/** 骨架目录（相对 `.profer/`）；`profer.json` 单独处理，已存在时不覆盖。 */
const PROJECT_SKELETON_DIRS = ['memory', 'skills', 'skills-inactive', 'workspace-files'] as const

/**
 * 项目工作区生命周期错误。
 *
 * `code` 是稳定分类，`message` 直接面向用户（IPC 只序列化 message，控制台会同时拿到 code）。
 */
export class ProjectWorkspaceError extends Error {
  constructor(public readonly code: ProjectWorkspaceErrorCode, message: string) {
    super(message)
    this.name = 'ProjectWorkspaceError'
  }
}

interface ProjectManifest {
  schema?: unknown
  name?: unknown
  createdAt?: unknown
  proferVersion?: unknown
  [key: string]: unknown
}

/** 子路径是否位于 parent 内（含相等）。两侧都应已归一化，避免符号链接歧义。 */
function isPathInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 校验项目根路径的形状与边界（不写探针）。
 *
 * 顺序刻意“从便宜到昂贵”：先形状、再存在性、再目录、再边界。
 *
 * @returns realpath 归一化后的项目根（I5 的唯一性判据）
 */
function resolveProjectRootPath(rootPathInput: unknown): string {
  if (typeof rootPathInput !== 'string' || rootPathInput.trim().length === 0) {
    throw new ProjectWorkspaceError('path-not-absolute', '项目路径不能为空')
  }
  const rawPath = rootPathInput.trim()
  if (!isAbsolute(rawPath)) {
    throw new ProjectWorkspaceError('path-not-absolute', `项目路径必须是绝对路径：${rawPath}`)
  }

  const absolutePath = resolve(rawPath)
  if (!existsSync(absolutePath)) {
    throw new ProjectWorkspaceError('path-not-found', `项目路径不存在：${absolutePath}`)
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(absolutePath)
  } catch {
    throw new ProjectWorkspaceError('path-not-found', `项目路径不可访问：${absolutePath}`)
  }
  if (!stats.isDirectory()) {
    throw new ProjectWorkspaceError('path-not-directory', `项目路径不是文件夹：${absolutePath}`)
  }

  const canonicalRoot = canonicalizeWorkspaceRootPath(absolutePath)
  if (parse(canonicalRoot).root === canonicalRoot) {
    throw new ProjectWorkspaceError('path-is-filesystem-root', `不能把文件系统根目录绑定为项目：${canonicalRoot}`)
  }

  // 双向边界检查：
  // ① 项目在配置目录内 → Profer 自己会变成项目内容；
  // ② 配置目录在项目内（如选中 home）→ `<root>/.profer` 会撞上全局配置根，直接破坏索引与会话。
  const canonicalConfigDir = canonicalizeWorkspaceRootPath(getConfigDir())
  if (isPathInsideOrEqual(canonicalRoot, canonicalConfigDir)) {
    throw new ProjectWorkspaceError('path-inside-config-dir', `不能把 Profer 配置目录或其子目录绑定为项目：${canonicalRoot}`)
  }
  if (isPathInsideOrEqual(canonicalConfigDir, canonicalRoot)) {
    throw new ProjectWorkspaceError('path-inside-config-dir', `不能把 Profer 配置目录的父目录绑定为项目：${canonicalRoot}`)
  }

  return canonicalRoot
}

/** 实际写入一个临时探针再删除：只读目录在 access(W_OK) 之外还有挂载/ACL 等形态。 */
function assertProjectDirectoryWritable(canonicalRoot: string): void {
  // 已存在 `.profer` 时骨架文件写在它里面：只测项目根会漏掉“根可写但 .profer 只读”
  const projectConfigDir = join(canonicalRoot, PROJECT_CONFIG_DIR_NAME)
  const probeDir = existsSync(projectConfigDir) ? projectConfigDir : canonicalRoot
  const probePath = join(probeDir, `.profer-write-probe-${randomUUID()}`)
  try {
    writeFileSync(probePath, 'profer', { encoding: 'utf-8', flag: 'wx' })
  } catch {
    throw new ProjectWorkspaceError('path-not-writable', `项目目录不可写：${probeDir}`)
  }
  try {
    unlinkSync(probePath)
  } catch {
    // 探针删不掉不影响“可写”结论；留一个明确日志便于排查
    console.warn(`[Agent 工作区] 项目可写性探针清理失败: ${probePath}`)
  }
}

function findProjectWorkspaceByRootPath(index: AgentWorkspacesIndex, canonicalRoot: string): AgentWorkspace | undefined {
  return index.workspaces.find((workspace) => {
    if (workspace.storageMode !== 'project') return false
    if (typeof workspace.rootPath !== 'string' || !isAbsolute(workspace.rootPath)) return false
    return canonicalizeWorkspaceRootPath(workspace.rootPath) === canonicalRoot
  })
}

function readProjectManifest(manifestPath: string): ProjectManifest | null {
  if (!existsSync(manifestPath)) return null

  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf-8')
  } catch {
    throw new ProjectWorkspaceError('manifest-invalid', `项目清单不可读，已停止以避免覆盖：${manifestPath}`)
  }
  if (raw.trim().length === 0) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProjectWorkspaceError('manifest-invalid', `项目清单格式损坏，已停止以避免覆盖：${manifestPath}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectWorkspaceError('manifest-invalid', `项目清单不是对象，已停止以避免覆盖：${manifestPath}`)
  }
  return parsed as ProjectManifest
}

/** `profer.project/1` 视为当前版本；缺失 schema 视为旧格式（可补写）。 */
function isCurrentManifestSchema(schema: unknown): boolean {
  return schema === undefined || schema === PROJECT_MANIFEST_SCHEMA
}

/** 未知主版本：只读打开，不改写（与预设 schema 的 I9 原则一致）。 */
function isFutureManifestSchema(schema: unknown): boolean {
  return typeof schema === 'string' && schema.startsWith(PROJECT_MANIFEST_SCHEMA_PREFIX) && schema !== PROJECT_MANIFEST_SCHEMA
}

/** 回滚只删“本次新建”的路径：文件逐个 unlink，目录只 rmdir（非空即跳过，绝不递归）。 */
function rollbackCreatedProjectPaths(createdPaths: string[]): void {
  for (let i = createdPaths.length - 1; i >= 0; i--) {
    const target = createdPaths[i]!
    try {
      if (!existsSync(target)) continue
      if (statSync(target).isDirectory()) {
        rmdirSync(target)
      } else {
        unlinkSync(target)
      }
    } catch {
      // 回滚是尽力而为：残留文件不会影响索引正确性
    }
  }
}

function buildProjectSkeletonFiles(name: string, includePresets: boolean): Array<{ relativePath: string; content: string }> {
  const files: Array<{ relativePath: string; content: string }> = [
    { relativePath: 'profile.md', content: `# ${name}\n\n项目资料与工作方式约定；Agent 会自动读取本文件。\n` },
    { relativePath: join('memory', 'MEMORY.md'), content: '# 项目记忆索引\n\n短索引与路由；详细正文写入 `workspace-files/.context/memory-archive/`。\n' },
    // 运行时读取的键名是 `servers`（agent-workspace-manager.ts 的 mcpConfig.servers），
    // 骨架必须与读取契约一致，否则新建项目的 MCP 配置永远读不到。
    { relativePath: 'mcp.json', content: `${JSON.stringify({ servers: {} }, null, 2)}\n` },
    { relativePath: 'config.json', content: '{}\n' },
    { relativePath: '.gitignore', content: PROJECT_GITIGNORE_CONTENT },
  ]
  // 旧单文件存在时不预生成 presets/：目录权威标记是 `presets/_config.json`（P1-4），
  // 空目录本身已不会遮蔽旧岗位，但凭空造一个空目录仍会让用户看到两套布局，没必要。
  if (includePresets) {
    files.push({ relativePath: join('presets', '_config.json'), content: `${JSON.stringify(PROJECT_PRESETS_CONFIG, null, 2)}\n` })
  }
  return files
}

interface MaterializeProjectSkeletonOptions {
  name: string
  proferVersion: string
  /** false = 清单 schema 未知，只读打开，绝不改写 profer.json */
  writeManifest: boolean
}

/**
 * 生成骨架（只创建缺失项）。
 *
 * @returns 本次新建的路径（供索引写入失败时回滚）
 */
function materializeProjectSkeleton(configDir: string, options: MaterializeProjectSkeletonOptions): string[] {
  const createdPaths: string[] = []

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir)
      createdPaths.push(configDir)
    }

    const hasLegacyPresets = existsSync(join(configDir, 'agent-presets.json'))
    if (!hasLegacyPresets) {
      const presetsDir = join(configDir, 'presets')
      if (!existsSync(presetsDir)) {
        mkdirSync(presetsDir)
        createdPaths.push(presetsDir)
      }
    }

    for (const relativeDir of PROJECT_SKELETON_DIRS) {
      const dir = join(configDir, relativeDir)
      if (existsSync(dir)) continue
      mkdirSync(dir)
      createdPaths.push(dir)
    }

    for (const file of buildProjectSkeletonFiles(options.name, !hasLegacyPresets)) {
      const filePath = join(configDir, file.relativePath)
      if (existsSync(filePath)) continue
      writeFileSync(filePath, file.content, 'utf-8')
      createdPaths.push(filePath)
    }

    if (options.writeManifest) {
      const manifestPath = join(configDir, PROJECT_MANIFEST_FILE)
      const existing = readProjectManifest(manifestPath)
      const existingName = typeof existing?.name === 'string' ? existing.name.trim() : ''
      const existingCreatedAt = typeof existing?.createdAt === 'string' ? existing.createdAt : ''
      const existingVersion = typeof existing?.proferVersion === 'string' ? existing.proferVersion : ''

      // 保留未知字段（round-trip），只补本版本认识的键
      const nextManifest: ProjectManifest = {
        ...(existing ?? {}),
        schema: PROJECT_MANIFEST_SCHEMA,
        name: existingName || options.name,
        createdAt: existingCreatedAt || new Date().toISOString(),
        proferVersion: existingVersion || options.proferVersion,
      }

      if (!existing || JSON.stringify(existing) !== JSON.stringify(nextManifest)) {
        writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf-8')
        if (!existing) createdPaths.push(manifestPath)
      }
    }

    return createdPaths
  } catch (error) {
    rollbackCreatedProjectPaths(createdPaths)
    throw error
  }
}

/**
 * 打开已有项目（设计 §6.2）：读清单、补齐骨架、复用已有绑定。
 *
 * 也承担“创建”的骨架生成：`createProjectWorkspace` 通过它统一走一条代码路径，
 * 避免创建/打开两套骨架逻辑漂移。
 */
export function openProjectWorkspace(input: OpenProjectWorkspaceInput): ProjectWorkspaceOpenResult {
  // 打开只校验形状与边界：骨架已经齐全的只读项目也应该能打开（写入失败在下面单独映射）
  const canonicalRoot = resolveProjectRootPath(input?.rootPath)
  const configDir = join(canonicalRoot, PROJECT_CONFIG_DIR_NAME)
  const manifestPath = join(configDir, PROJECT_MANIFEST_FILE)

  // 清单必须在写骨架之前读：损坏的清单是“停止信号”，不能先写别的文件再发现
  const existingManifest = readProjectManifest(manifestPath)
  const warnings: string[] = []
  let writeManifest = true
  if (existingManifest && !isCurrentManifestSchema(existingManifest.schema)) {
    writeManifest = false
    if (isFutureManifestSchema(existingManifest.schema)) {
      warnings.push(`项目清单 schema 版本较新（${String(existingManifest.schema)}），已只读打开，未改写 profer.json；请升级 Profer`)
    } else {
      warnings.push(`项目清单 schema 无法识别（${String(existingManifest.schema)}），已只读打开，未改写 profer.json`)
    }
  }

  const manifestName = typeof existingManifest?.name === 'string' ? existingManifest.name.trim() : ''
  const requestedName = typeof input?.name === 'string' ? input.name.trim() : ''
  const resolvedName = manifestName || requestedName || basename(canonicalRoot)
  const proferVersion = typeof input?.proferVersion === 'string' && input.proferVersion.trim().length > 0
    ? input.proferVersion.trim()
    : 'unknown'

  let createdPaths: string[]
  try {
    createdPaths = materializeProjectSkeleton(configDir, { name: resolvedName, proferVersion, writeManifest })
  } catch (error) {
    // 打开不强制要求可写：骨架完整时只读目录也能正常打开；只有“需要补写”时才报不可写
    if (error instanceof ProjectWorkspaceError) throw error
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new ProjectWorkspaceError('path-not-writable', `项目目录不可写，无法补齐 .profer 骨架：${configDir}`)
    }
    throw error
  }

  const index = readIndex()
  const existing = findProjectWorkspaceByRootPath(index, canonicalRoot)
  if (existing) {
    console.log(`[Agent 工作区] 已识别 Profer 项目（复用既有绑定）: ${existing.name} (${canonicalRoot})`)
    return { workspace: existing, created: false, warnings }
  }

  const now = Date.now()
  const workspace: AgentWorkspace = {
    id: randomUUID(),
    name: resolvedName,
    slug: slugify(resolvedName, new Set(index.workspaces.map((w) => w.slug))),
    createdAt: now,
    updatedAt: now,
    type: 'personal',
    storageMode: 'project',
    rootPath: canonicalRoot,
  }

  index.workspaces.unshift(workspace)
  try {
    writeIndex(index)
  } catch (error) {
    // 索引没写成功 = 这次绑定不存在：只回滚本次补的骨架，项目既有文件一个不动
    rollbackCreatedProjectPaths(createdPaths)
    console.error(`[Agent 工作区] 写入项目索引失败，已回滚本次新建骨架 (${canonicalRoot}):`, error)
    throw error
  }
  invalidateWorkspaceLocation(workspace.slug)

  console.log(`[Agent 工作区] 已绑定项目工作区: ${workspace.name} (${canonicalRoot})，本次补建 ${createdPaths.length} 项`)
  return { workspace, created: true, warnings }
}

/**
 * 创建项目工作区（设计 §6.1）。
 *
 * 与 `openProjectWorkspace` 的差别只有两点：创建会拒绝“已绑定”的目录（给友好错误），
 * 且要求调用方提供 `proferVersion`；骨架生成完全复用打开路径。
 */
export function createProjectWorkspace(input: CreateProjectWorkspaceInput): ProjectWorkspaceOpenResult {
  if (typeof input?.proferVersion !== 'string' || input.proferVersion.trim().length === 0) {
    throw new Error('创建项目工作区需要 proferVersion（由主进程注入）')
  }

  const canonicalRoot = resolveProjectRootPath(input.rootPath)
  const index = readIndex()
  const bound = findProjectWorkspaceByRootPath(index, canonicalRoot)
  if (bound) {
    // writeIndex 的唯一校验是最后防线；这里提前给可读文案，避免用户看到“索引写入失败”
    throw new ProjectWorkspaceError('already-bound', `该文件夹已绑定为项目「${bound.name}」：${canonicalRoot}`)
  }

  // 创建必须在目录内真实写一下：权限位、ACL、只读挂载都可能在 access(W_OK) 之外拒绝
  assertProjectDirectoryWritable(canonicalRoot)

  // `<root>/.profer` 已存在时同样走 open：只补缺失项，不覆盖既有 profile.md / mcp.json / presets
  return openProjectWorkspace({
    rootPath: canonicalRoot,
    name: input.name,
    proferVersion: input.proferVersion.trim(),
  })
}

/** 项目分支的唯一实现：只删索引条目，磁盘零操作（I2）。 */
function removeProjectIndexEntry(index: AgentWorkspacesIndex, target: AgentWorkspaceIndexEntry, source: 'delete' | 'remove'): void {
  const degraded = target.degradedFromProject === true
  if (!degraded && (typeof target.rootPath !== 'string' || !isAbsolute(target.rootPath))) {
    // 索引损坏时宁可不删，也不能猜一个路径去删
    throw new ProjectWorkspaceError('not-a-project-workspace', `项目工作区索引缺少有效 rootPath，已拒绝移除：${target.id}`)
  }
  const idx = index.workspaces.findIndex((workspace) => workspace.id === target.id)
  if (idx === -1) {
    throw new ProjectWorkspaceError('workspace-not-found', `项目工作区不存在：${target.id}`)
  }

  index.workspaces.splice(idx, 1)
  writeIndex(index)
  invalidateWorkspaceLocation(target.slug)

  const degradedNote = degraded ? '（索引已损坏：缺少 rootPath，仅删索引）' : ''
  console.log(`[Agent 工作区] 已移除项目工作区（仅索引，未触碰磁盘，来源: ${source}）${degradedNote}: ${target.name} (slug: ${target.slug})`)
}

/**
 * 移除项目工作区（设计 §6.3）。
 *
 * 项目是外部资产，允许移除最后一个 project（managed 的「至少保留一个」规则不适用）。
 * 只删索引：项目文件、`.profer`、会话记录全部保留。
 */
export function removeProjectWorkspace(id: string): void {
  const index = readIndex()
  const target = index.workspaces.find((workspace) => workspace.id === id)
  if (!target) {
    throw new ProjectWorkspaceError('workspace-not-found', `项目工作区不存在：${id}`)
  }
  if (target.storageMode !== 'project' && target.degradedFromProject !== true) {
    throw new ProjectWorkspaceError('not-a-project-workspace', `「${target.name}」不是项目模式工作区，不能按项目移除`)
  }
  removeProjectIndexEntry(index, target, 'remove')
}

/** 确保默认工作区存在，首次启动时自动创建（slug: default） */
export function ensureDefaultWorkspace(): AgentWorkspace {
  const index = readIndex()
  let defaultWs = index.workspaces.find((w) => w.slug === 'default')

  if (!defaultWs) {
    const now = Date.now()
    defaultWs = {
      id: randomUUID(),
      name: '默认工作区',
      slug: 'default',
      createdAt: now,
      updatedAt: now,
      type: 'personal',
    }

    getAgentWorkspacePath('default')
    ensurePluginManifest('default', '默认工作区')

    index.workspaces.push(defaultWs)
    writeIndex(index)
    invalidateWorkspaceLocation(defaultWs.slug)

    console.log('[Agent 工作区] 已创建默认工作区')
  } else {
    // 迁移兼容：确保已有默认工作区包含 plugin manifest
    ensurePluginManifest(defaultWs.slug, defaultWs.name)
  }

  return defaultWs
}

// ===== Plugin Manifest（SDK 插件发现） =====

/**
 * 确保工作区包含 .claude-plugin/plugin.json（SDK 需要此文件发现 managed 工作区 skills）。
 *
 * project 模式刻意跳过：`<root>/.profer/.claude-plugin/` 会把 Profer 工具产物写进用户仓库
 * （审计 §4.4）。运行时技能投影（`.runtime/skills`）自带 plugin.json，SDK 侧不依赖
 * 工作区级清单，因此默认不写；若后续确认必需，改写 central runtimeDir，绝不动项目目录。
 */
export function ensurePluginManifest(workspaceSlug: string, workspaceName: string): void {
  if (resolveWorkspaceLocation(workspaceSlug).mode === 'project') return

  const wsPath = getAgentWorkspacePath(workspaceSlug)
  const pluginDir = join(wsPath, '.claude-plugin')
  const manifestPath = join(pluginDir, 'plugin.json')

  if (existsSync(manifestPath)) return

  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true })
  }

  const manifest = {
    name: `profer-workspace-${workspaceSlug}`,
    version: '1.0.0',
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`[Agent 工作区] 已创建 plugin manifest: ${workspaceSlug}`)
}

// ===== MCP 配置管理 =====

type McpServerMap = Record<string, McpServerEntry>

/** `<configDir>/mcp.local.json`：本机覆盖层，永不提交、永不写回。 */
function resolveMcpLocalPath(mcpPath: string): string {
  return join(dirname(mcpPath), 'mcp.local.json')
}

/**
 * 读取一个 MCP 配置文件里的 servers（容错）。
 *
 * - 文件不存在 → `null`（调用方据此区分「没有覆盖层」与「覆盖层是空对象」）
 * - JSON 非法 / servers 形态不对 → `null`，绝不让损坏的配置炸掉运行时
 */
function readMcpServersFile(filePath: string): McpServerMap | null {
  if (!existsSync(filePath)) return null

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<WorkspaceMcpConfig>
    const servers = parsed.servers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    return servers as McpServerMap
  } catch (error) {
    console.error('[Agent 工作区] 读取 MCP 配置失败:', filePath, error)
    return null
  }
}

/** 缺 `type` 的条目按 command/url 推断（合并之后再做，避免局部覆盖层把 type 带偏）。 */
function inferMcpTransportTypes(servers: McpServerMap): void {
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object' || entry.type) continue
    entry.type = entry.command ? 'stdio' : entry.url ? 'http' : 'stdio'
    console.log(`[Agent 工作区] MCP 服务器 "${name}" 缺少 type 字段，已自动推断为 "${entry.type}"`)
  }
}

/** env / headers 的键级合并：local 的键覆盖 base，其余 base 键保留。 */
function mergeMcpStringMap(
  base: Record<string, string> | undefined,
  local: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !local) return undefined
  return { ...base, ...local }
}

/**
 * 按 server 名合并 `mcp.json` ← `mcp.local.json`（只读，local 覆盖 base）。
 *
 * - 同名 server：标量/数组字段（type、command、args、url、timeout、enabled、isBuiltin…）
 *   以 local 为准，`env` / `headers` 做键级深合并；
 * - 只存在于 local 的 server：一并生效（`local-only`）；
 * - 只存在于 base 的 server：保持原样。
 */
function mergeMcpServerLayers(base: McpServerMap, local: McpServerMap): McpServerMap {
  const merged: McpServerMap = { ...base }

  for (const [name, localEntry] of Object.entries(local)) {
    if (!localEntry || typeof localEntry !== 'object') continue
    const baseEntry = merged[name]
    if (!baseEntry) {
      merged[name] = { ...localEntry }
      continue
    }
    merged[name] = {
      ...baseEntry,
      ...localEntry,
      env: mergeMcpStringMap(baseEntry.env, localEntry.env),
      headers: mergeMcpStringMap(baseEntry.headers, localEntry.headers),
    }
  }

  return merged
}

/** 比较 MCP 字段值是否相同（只用于「这处改动是不是来自 local 覆盖层」的判定）。 */
function isSameMcpFieldValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index])
  }
  return false
}

/**
 * 写盘前把「合并层」回退成 base 层：local 的内容永不写进 `mcp.json`。
 *
 * 存在这条链路是因为保存方普遍是「读 → 改 → 写」（如 lark-mcp 的启用/停用）。
 * 若直接写回 `getWorkspaceMcpConfig()` 的合并结果，local 的密钥会被固化进受版本控制的
 * `mcp.json`（A15 明确禁止）。规则：
 * - local 独有的 server：不落盘（它本来只在本机生效）；
 * - local 覆写的 server：保留该 server，但把取值仍等于 local 覆写值的字段回退到 base 的取值，
 *   等于「base 不存在该键」时删除该键。
 */
function revertLocalMcpOverrides(
  base: McpServerMap,
  local: McpServerMap,
  next: McpServerMap,
): McpServerMap {
  const SCALAR_FIELDS = ['type', 'command', 'args', 'url', 'timeout', 'enabled', 'isBuiltin'] as const
  const MAP_FIELDS = ['env', 'headers'] as const

  const reverted: McpServerMap = {}

  for (const [name, entry] of Object.entries(next)) {
    const localEntry = local[name]
    if (!localEntry || typeof localEntry !== 'object') {
      reverted[name] = entry
      continue
    }

    const baseEntry = base[name]
    if (!baseEntry) continue // local-only：绝不写进 base 文件

    const draft = { ...entry } as Record<string, unknown>
    const baseRecord = baseEntry as unknown as Record<string, unknown>
    const localRecord = localEntry as unknown as Record<string, unknown>

    for (const field of SCALAR_FIELDS) {
      if (localRecord[field] === undefined) continue
      if (!isSameMcpFieldValue(draft[field], localRecord[field])) continue
      if (baseRecord[field] === undefined) delete draft[field]
      else draft[field] = baseRecord[field]
    }

    for (const field of MAP_FIELDS) {
      const localMap = localRecord[field]
      const draftMap = draft[field]
      if (!localMap || typeof localMap !== 'object' || !draftMap || typeof draftMap !== 'object') continue
      const baseMap = (baseRecord[field] ?? {}) as Record<string, unknown>
      const nextMap: Record<string, unknown> = { ...(draftMap as Record<string, unknown>) }
      for (const [key, value] of Object.entries(localMap as Record<string, unknown>)) {
        if (nextMap[key] !== value) continue
        if (baseMap[key] === undefined) delete nextMap[key]
        else nextMap[key] = baseMap[key]
      }
      if (Object.keys(nextMap).length === 0) delete draft[field]
      else draft[field] = nextMap
    }

    reverted[name] = draft as unknown as McpServerEntry
  }

  return reverted
}

/**
 * 读取工作区 MCP 配置（运行时生效视图）。
 *
 * project 模式在 base `mcp.json` 之上叠加只读的 `mcp.local.json`（本机密钥层）。
 * managed 行为不变：不读 local 覆盖层。
 */
export function getWorkspaceMcpConfig(workspaceSlug: string): WorkspaceMcpConfig {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug)
  const baseServers = readMcpServersFile(mcpPath) ?? {}

  // 只有 project 的 `.profer` 是受版本控制的团队资产，才需要本机覆盖层；managed 保持原语义
  if (resolveWorkspaceLocation(workspaceSlug).mode === 'project') {
    const localServers = readMcpServersFile(resolveMcpLocalPath(mcpPath))
    if (localServers) {
      const merged = mergeMcpServerLayers(baseServers, localServers)
      inferMcpTransportTypes(merged)
      return { servers: merged }
    }
  }

  inferMcpTransportTypes(baseServers)
  return { servers: baseServers }
}

export function saveWorkspaceMcpConfig(workspaceSlug: string, config: WorkspaceMcpConfig): void {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug)

  try {
    const payload = toBaseMcpConfig(workspaceSlug, mcpPath, config)
    writeFileSync(mcpPath, JSON.stringify(payload, null, 2), 'utf-8')
    console.log(`[Agent 工作区] 已保存 MCP 配置: ${workspaceSlug}`)
  } catch (error) {
    console.error('[Agent 工作区] 保存 MCP 配置失败:', error)
    throw new Error('保存 MCP 配置失败')
  }
}

/**
 * 只写入某个 MCP server 的测试结果（本机状态，不属于团队配置）。
 *
 * 分层的理由：`lastTestResult` 含工具清单与时间戳，是「这台机器上次探测到的结果」，
 * 写进受版本控制的 `mcp.json` 会让每个人每次点「测试连接」都弄脏仓库。
 * - project 工作区：写 `mcp.local.json`（本机层），base 文件保持干净；
 * - managed 工作区：没有 local 层，写回 `mcp.json`。
 *
 * server 在两层都不存在时不创建条目（避免为尚未保存的配置留下幽灵记录）。
 * 返回是否真的写入了。
 */
export function saveMcpServerTestResult(
  workspaceSlug: string,
  serverName: string,
  result: McpServerEntry['lastTestResult'],
): boolean {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug)
  const isProject = resolveWorkspaceLocation(workspaceSlug).mode === 'project'
  const targetPath = isProject ? resolveMcpLocalPath(mcpPath) : mcpPath

  const baseServers = readMcpServersFile(mcpPath) ?? {}
  const targetServers = isProject ? (readMcpServersFile(targetPath) ?? {}) : baseServers
  const existing = targetServers[serverName] ?? baseServers[serverName]
  if (!existing) {
    console.warn(`[Agent 工作区] 跳过 MCP 测试结果落盘：${workspaceSlug}/${serverName} 不存在`)
    return false
  }

  const nextServers: McpServerMap = {
    ...targetServers,
    [serverName]: { ...existing, lastTestResult: result },
  }

  try {
    writeFileSync(targetPath, JSON.stringify({ servers: nextServers }, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('[Agent 工作区] 写入 MCP 测试结果失败:', error)
    return false
  }
}

/** 写盘前的 base 层还原：project 才需要剥离 local 覆盖层，managed 原样写入。 */
function toBaseMcpConfig(workspaceSlug: string, mcpPath: string, config: WorkspaceMcpConfig): WorkspaceMcpConfig {
  if (resolveWorkspaceLocation(workspaceSlug).mode !== 'project') return config

  const localServers = readMcpServersFile(resolveMcpLocalPath(mcpPath))
  if (!localServers) return config

  const baseServers = readMcpServersFile(mcpPath) ?? {}
  const servers = config.servers ?? {}
  return { ...config, servers: revertLocalMcpOverrides(baseServers, localServers, servers) }
}

// ===== Skill 目录扫描 =====

/** 扫描工作区 Skills（包括 skills/ 与 skills-inactive/），并保留全局引用。 */
export function getWorkspaceSkills(workspaceSlug: string): SkillMeta[] {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const activeSkills = scanSkillsInDir(getWorkspaceSkillsDir(workspaceSlug), true)
  const inactiveSkills = scanSkillsInDir(getInactiveSkillsDir(workspaceSlug), false)
  const globalSkills = listGlobalSkills(workspaceSlug)
    .filter((skill) => skill.actualSource !== 'workspace')
    .map((skill): SkillMeta => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      enabled: skill.actualSource === 'global' && skill.enabledInWorkspace,
      actualSource: skill.actualSource,
      sourceSkillId: skill.skillId,
      sourceSkillType: skill.type,
      sourceVersion: skill.version,
      sourceStatus: 'available',
    }))
  return [...activeSkills, ...inactiveSkills, ...globalSkills]
}

/** 解析 SKILL.md 的 YAML frontmatter，支持单行值、block scalar（`|` / `>`）和多行缩进 */
export function parseSkillFrontmatter(content: string, slug: string, enabled: boolean): SkillMeta {
  const meta: SkillMeta = { slug, name: slug, enabled }

  // 移除 UTF-8 BOM（﻿），确保 YAML frontmatter 匹配不受 BOM 干扰
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return meta

  const yaml = fmMatch[1]
  if (!yaml) return meta

  const validKeys = new Set(['name', 'description', 'group', 'icon', 'version'])
  const entries: Record<string, string> = {}
  let currentKey = ''
  let isFolded = false

  for (const line of yaml.split('\n')) {
    const indented = /^\s/.test(line)

    if (!indented) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) { currentKey = ''; continue }

      const key = line.slice(0, colonIdx).trim()
      const raw = line.slice(colonIdx + 1).trim()

      if (!validKeys.has(key)) { currentKey = ''; isFolded = false; continue }

      if (raw === '|' || raw === '>') {
        currentKey = key
        isFolded = raw === '>'
        entries[key] = ''
        continue
      }

      currentKey = key
      isFolded = false
      entries[key] = raw.replace(/^["']|["']$/g, '')
    } else if (currentKey) {
      const text = line.trim()
      if (!text) { if (entries[currentKey]) entries[currentKey] += '\n'; continue }
      const sep = isFolded ? ' ' : '\n'
      entries[currentKey] = entries[currentKey] ? entries[currentKey] + sep + text : text
    }
  }

  if (entries.name) meta.name = entries.name.trim()
  if (entries.description) meta.description = entries.description.trim()
  if (entries.group) meta.group = entries.group.trim()
  if (entries.icon) meta.icon = entries.icon.trim()
  if (entries.version) meta.version = entries.version.trim()

  return meta
}

// ===== 工作区能力摘要 =====

export function getWorkspaceCapabilities(workspaceSlug: string): WorkspaceCapabilities {
  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
  const skills = getWorkspaceSkills(workspaceSlug)

  const mcpServers = Object.entries(mcpConfig.servers ?? {}).map(([name, entry]) => ({
    name,
    enabled: entry.enabled,
    type: entry.type,
  }))

  const memory = getWorkspaceMemorySummary(workspaceSlug)

  return { mcpServers, builtinMcpServers: [], skills, memory }
}

export function createWorkspaceSkill(workspaceSlug: string, skillSlug: string, name: string, description: string, content: string): void {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  const normalizedSlug = skillSlug.trim()
  assertSafeSkillSegment(normalizedSlug, 'Skill slug')
  if (!normalizedSlug) throw new Error('Skill slug 不能为空')
  if (!name.trim()) throw new Error('Skill 名称不能为空')
  const target = join(getWorkspaceSkillsDir(workspaceSlug), normalizedSlug)
  if (findSkillPathInRoot(getWorkspaceSkillsDir(workspaceSlug), normalizedSlug)
    || findSkillPathInRoot(getInactiveSkillsDir(workspaceSlug), normalizedSlug)) {
    throw new Error(`Skill 已存在: ${normalizedSlug}`)
  }
  mkdirSync(target, { recursive: true })
  const frontmatter = `---\nname: ${name.trim()}\ndescription: ${description.trim()}\nversion: 1.0.0\n---\n\n${content}`
  writeFileSync(join(target, 'SKILL.md'), frontmatter, 'utf-8')
  writeSkillSource(target, { scope: 'workspace', workspaceSkillId: randomUUID() })
  console.log(`[Agent 工作区] 已创建 Skill: ${workspaceSlug}/${normalizedSlug}`)
}

/** 将当前工作区 Skill 提升为用户全局 Skill；原工作区副本是否保留由调用方明确传入。 */
export function promoteWorkspaceSkillToGlobal(workspaceSlug: string, skillSlug: string, targetWorkspaceSlugs: string[], keepWorkspaceCopy = true): import('@profer/shared').GlobalSkillManifest {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  const skillSlugKey = canonicalSkillSegmentKey(skillSlug)
  const skill = getAllWorkspaceSkills(workspaceSlug).find((item) => canonicalSkillSegmentKey(item.slug) === skillSlugKey && item.actualSource === 'workspace')
  if (!skill) throw new Error(`工作区 Skill 不存在: ${skillSlug}`)
  const content = readWorkspaceSkillContent(workspaceSlug, skill.slug)
  const created = createUserGlobalSkill(skill.slug, skill.name, skill.description ?? '', content)
  for (const target of targetWorkspaceSlugs) {
    assertSafeSkillSegment(target, 'target workspaceSlug')
    setGlobalSkillEnabled(target, created.skillId, true)
  }
  if (keepWorkspaceCopy) {
    const activePath = findSkillPathInRoot(getWorkspaceSkillsDir(workspaceSlug), skill.slug)
    const inactiveDir = getInactiveSkillsDir(workspaceSlug)
    if (activePath) {
      if (findSkillPathInRoot(inactiveDir, skill.slug)) throw new Error(`目标目录已存在同名 Skill: ${skill.slug}`)
      renameSync(activePath, join(inactiveDir, basename(activePath)))
    }
  } else {
    deleteWorkspaceSkill(workspaceSlug, skill.slug)
  }
  return created
}

export function deleteWorkspaceSkill(workspaceSlug: string, skillSlug: string): void {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  const skillPath = resolveSkillDir(workspaceSlug, skillSlug)
  if (!skillPath) throw new Error(`Skill 不存在: ${skillSlug}`)
  rmSync(skillPath, { recursive: true, force: true })
  console.log(`[Agent 工作区] 已删除 Skill: ${workspaceSlug}/${skillSlug}`)
}

/** 扫描指定目录下的 Skills，供 getWorkspaceSkills 和 getAllWorkspaceSkills 复用 */
export function scanSkillsInDir(dir: string, enabled: boolean): SkillMeta[] {
  const skills: SkillMeta[] = []

  try {
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory())
      if (!isDir) continue

      const skillMdPath = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        const meta = parseSkillFrontmatter(content, entry.name, enabled)

        // 新全局体系与旧工作区导入共用 .source.json，但来源语义不同：
        // 新格式没有 sourceWorkspaceSlug，不能误走旧的“回源工作区”逻辑。
        const skillDir = join(dir, entry.name)
        let source = readSkillSource(skillDir)
        if (!source) {
          source = { scope: 'workspace', workspaceSkillId: randomUUID() }
          writeSkillSource(skillDir, source)
        } else if (!source.workspaceSkillId) {
          source = { ...source, workspaceSkillId: randomUUID() }
          writeSkillSource(skillDir, source)
        }
        meta.workspaceSkillId = source.workspaceSkillId
        if (source) {
          if (isWorkspaceSkillSource(source)) {
            if (source.sourceSkillId) meta.sourceSkillId = source.sourceSkillId
            if (source.sourceSkillType) meta.sourceSkillType = source.sourceSkillType
            if (source.sourceVersion) meta.sourceVersion = source.sourceVersion
            if (source.copiedAt) meta.copiedAt = source.copiedAt
            if (source.replacementForSkillId) meta.replacementForSkillId = source.replacementForSkillId
            if (source.sourceStatus) meta.sourceStatus = source.sourceStatus
            meta.actualSource = enabled ? 'workspace' : 'none'
          } else {
            meta.importSource = source
            const sourceSkillDir = resolveSkillDir(source.sourceWorkspaceSlug, entry.name)
            if (sourceSkillDir) {
              const currentSourceVersion = parseSkillVersion(sourceSkillDir)
              meta.hasUpdate = isNewerVersion(currentSourceVersion, source.sourceVersion)
            }
            meta.actualSource = enabled ? 'workspace' : 'none'
          }
        } else {
          meta.actualSource = enabled ? 'workspace' : 'none'
        }

        skills.push(meta)
      } catch {
        console.warn(`[Agent 工作区] 解析 Skill 失败: ${entry.name}`)
      }
    }
  } catch {
    // 目录可能不存在
  }

  return skills
}

/**
 * 旧 renderer 兼容 API：工作区目录中的 Skill（包括迁移来的旧元 Skill 副本）都可编辑。
 * 全局 builtin 的只读展示由 globalSkill API 提供，不能再按 slug 将本地副本误判为只读。
 */
export function getDefaultSkillSlugs(): string[] {
  return []
}

/** 获取工作区所有 Skills（含活跃和不活跃），用于设置页 UI */
export function getAllWorkspaceSkills(workspaceSlug: string, includeGlobalSkills = false): SkillMeta[] {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const activeSkills = scanSkillsInDir(getWorkspaceSkillsDir(workspaceSlug), true)
  const inactiveSkills = scanSkillsInDir(getInactiveSkillsDir(workspaceSlug), false)
  const globalSkills = listGlobalSkills(workspaceSlug).map((skill): SkillMeta => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    enabled: skill.enabledInWorkspace,
    actualSource: skill.enabledInWorkspace ? 'global' : 'none',
    sourceSkillId: skill.skillId,
    sourceSkillType: skill.type,
    sourceVersion: skill.version,
    sourceStatus: 'available',
  }))
  // 全局定义与工作区副本是两个可分别管理的条目；UI 可选择同时展示全局来源。
  return includeGlobalSkills ? [...activeSkills, ...inactiveSkills, ...globalSkills] : [...activeSkills, ...inactiveSkills]
}

/** 在 skills/ 和 skills-inactive/ 之间移动来切换启用/禁用 */
export function toggleWorkspaceSkill(workspaceSlug: string, skillSlug: string, enabled: boolean, sourceSkillId?: string): void {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  // 三态路由：非空 ID=全局，空字符串=明确本地，未传=本地优先后才回退全局。
  if (sourceSkillId !== undefined && sourceSkillId !== '') {
    assertSafeSkillSegment(sourceSkillId, 'sourceSkillId')
    const globalSkill = listGlobalSkills(workspaceSlug).find((skill) => skill.skillId === sourceSkillId)
    if (!globalSkill) throw new Error(`全局 Skill 不存在: ${sourceSkillId}`)
    setGlobalSkillEnabled(workspaceSlug, globalSkill.skillId, enabled)
    return
  }
  const activeDir = getWorkspaceSkillsDir(workspaceSlug)
  const inactiveDir = getInactiveSkillsDir(workspaceSlug)
  const activePath = findSkillPathInRoot(activeDir, skillSlug)
  const inactivePath = findSkillPathInRoot(inactiveDir, skillSlug)
  // 未传 sourceSkillId 时只有本地不存在才允许按 slug 回退全局，避免同名误操作。
  if (!activePath && !inactivePath && sourceSkillId === undefined) {
    const skillSlugKey = canonicalSkillSegmentKey(skillSlug)
    const globalSkill = listGlobalSkills(workspaceSlug).find((skill) => canonicalSkillSegmentKey(skill.slug) === skillSlugKey)
    if (globalSkill) {
      setGlobalSkillEnabled(workspaceSlug, globalSkill.skillId, enabled)
      return
    }
  }
  const srcPath = enabled ? inactivePath : activePath
  const destDir = enabled ? activeDir : inactiveDir
  if (!srcPath) throw new Error(`工作区 Skill 不存在: ${skillSlug}`)
  const actualSlug = basename(srcPath)
  const destPath = join(destDir, actualSlug)
  if (findSkillPathInRoot(destDir, actualSlug)) throw new Error(`目标目录已存在同名 Skill: ${actualSlug}`)
  renameSync(srcPath, destPath)
  console.log(`[Agent 工作区] Skill ${enabled ? '启用' : '禁用'}: ${workspaceSlug}/${actualSlug}`)
}

/**
 * 获取其他工作区的 Skill 列表，按工作区分组返回。
 */
export function getOtherWorkspaceSkills(currentSlug: string): OtherWorkspaceSkillsGroup[] {
  const workspaces = listAgentWorkspaces()
  const result: OtherWorkspaceSkillsGroup[] = []

  for (const workspace of workspaces) {
    if (workspace.slug === currentSlug) continue

    const skills = getAllWorkspaceSkills(workspace.slug)
    if (skills.length === 0) continue

    result.push({
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      skills,
    })
  }

  return result
}

// ===== 预设跨工作区导入（与 Skill 导入同构） =====

/**
 * 获取其他工作区的自定义预设列表，按工作区分组返回。
 * 内置预设不参与导入（每工作区恒有）。
 */
export function getOtherWorkspacePresets(currentSlug: string): OtherWorkspacePresetsGroup[] {
  const workspaces = listAgentWorkspaces()
  const result: OtherWorkspacePresetsGroup[] = []

  for (const workspace of workspaces) {
    if (workspace.slug === currentSlug) continue

    const presets = listAgentPresets(workspace.slug).filter((p) => !p.isBuiltin)
    if (presets.length === 0) continue

    result.push({
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      presets,
    })
  }

  return result
}

/**
 * 从其他工作区导入自定义预设到当前工作区（深拷贝 + 新 UUID）。
 */
export function importPresetFromWorkspace(
  targetSlug: string,
  sourceSlug: string,
  presetId: string,
): AgentPreset {
  const source = listAgentPresets(sourceSlug).find((p) => p.id === presetId && !p.isBuiltin)
  if (!source) {
    throw new Error(`源工作区中不存在自定义预设: ${presetId}`)
  }

  const imported = createAgentPreset(targetSlug, {
    name: source.name,
    description: source.description,
    promptSections: source.promptSections,
    suppressPromptSections: source.suppressPromptSections,
    disabledToolGroups: source.disabledToolGroups,
    effort: source.effort,
    permissionMode: source.permissionMode,
    skillSlugs: source.skillSlugs,
    mcpServerNames: source.mcpServerNames,
    allowSubagents: source.allowSubagents,
  })

  console.log(`[Agent 预设] 已从 ${sourceSlug} 导入预设: ${source.name} → ${targetSlug}/${imported.id}`)
  return imported
}

/**
 * 从其他工作区导入 Skill 到当前工作区。
 *
 * 复制目录并记录来源元数据（.source.json），支持后续版本检测和同步更新。
 */
export function importSkillFromWorkspace(
  targetSlug: string,
  sourceSlug: string,
  skillSlug: string,
): SkillMeta {
  assertSafeSkillSegment(targetSlug, 'target workspaceSlug')
  assertSafeSkillSegment(sourceSlug, 'source workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  const sourcePath = resolveSkillDir(sourceSlug, skillSlug)

  if (!sourcePath) {
    throw new Error(`源工作区中不存在 Skill: ${skillSlug}`)
  }
  const actualSkillSlug = basename(sourcePath)

  // P0 修复：复制前校验源 SKILL.md 存在，避免产生孤立目录
  const sourceSkillMdPath = join(sourcePath, 'SKILL.md')
  if (!existsSync(sourceSkillMdPath)) {
    throw new Error(`源 Skill 缺少 SKILL.md: ${skillSlug}`)
  }

  const targetSkillsDir = getWorkspaceSkillsDir(targetSlug)
  const targetInactiveDir = getInactiveSkillsDir(targetSlug)
  if (findSkillPathInRoot(targetSkillsDir, actualSkillSlug) || findSkillPathInRoot(targetInactiveDir, actualSkillSlug)) {
    throw new Error(`当前工作区已存在同名 Skill: ${actualSkillSlug}`)
  }
  const targetPath = join(targetSkillsDir, actualSkillSlug)

  // 库账本不属于技能本体，跨工作区导入时一并剥掉。
  copySkillDirectorySafely(sourcePath, targetPath, { exclude: LEDGER_FILENAMES })

  // 写入来源元数据
  const sourceWorkspace = listAgentWorkspaces().find((w) => w.slug === sourceSlug)
  const sourceSource = readSkillSource(sourcePath)
  const importSource: SkillImportSource = {
    // 导出/导入保留已存在的实体 ID；旧副本没有 ID 时才生成一次并写入目标元数据。
    workspaceSkillId: sourceSource?.workspaceSkillId ?? randomUUID(),
    sourceWorkspaceSlug: sourceSlug,
    sourceWorkspaceName: sourceWorkspace?.name ?? sourceSlug,
    importedAt: new Date().toISOString(),
    sourceVersion: parseSkillVersion(sourcePath),
  }
  writeSkillImportSource(targetPath, importSource)

  console.log(`[Agent 工作区] 已从 ${sourceSlug} 导入 Skill: ${targetSlug}/${actualSkillSlug}`)

  const content = readFileSync(join(targetPath, 'SKILL.md'), 'utf-8')
  const meta = parseSkillFrontmatter(content, actualSkillSlug, true)
  meta.importSource = importSource
  return meta
}

/**
 * 从源工作区同步更新已导入的 Skill（覆盖更新）。
 *
 * - 源不存在：抛出错误，不修改目标
 * - 本地已禁用（skills-inactive）：在 inactive 目录中原地更新，保留 enabled 状态
 */
export function updateSkillFromSource(
  targetSlug: string,
  skillSlug: string,
): SkillMeta {
  assertSafeSkillSegment(targetSlug, 'target workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  const activeDir = getWorkspaceSkillsDir(targetSlug)
  const inactiveDir = getInactiveSkillsDir(targetSlug)
  const activePath = findSkillPathInRoot(activeDir, skillSlug)
  const inactivePath = findSkillPathInRoot(inactiveDir, skillSlug)
  const targetPath = activePath ?? inactivePath

  if (!targetPath) {
    throw new Error(`当前工作区中不存在 Skill: ${skillSlug}`)
  }
  const actualSkillSlug = basename(targetPath)

  const existingSource = readSkillImportSource(targetPath)
  if (!existingSource) {
    throw new Error(`Skill ${skillSlug} 不是从其他工作区导入的，无法从源更新`)
  }

  const sourcePath = resolveSkillDir(existingSource.sourceWorkspaceSlug, actualSkillSlug)
  if (!sourcePath) {
    throw new Error(`源工作区中不再存在 Skill: ${skillSlug}（来源: ${existingSource.sourceWorkspaceName}）`)
  }

  if (!existsSync(join(sourcePath, 'SKILL.md'))) {
    throw new Error(`源 Skill 缺少 SKILL.md: ${skillSlug}`)
  }

  // 先复制到临时目录，成功后再替换旧目录，确保原子性
  const parentDir = join(targetPath, '..')
  const tmpPath = join(parentDir, `.${actualSkillSlug}.updating`)
  try {
    copySkillDirectorySafely(sourcePath, tmpPath, { exclude: LEDGER_FILENAMES })
  } catch (err) {
    // 复制失败时清理临时目录，保留原目录不变
    if (existsSync(tmpPath)) rmSync(tmpPath, { recursive: true, force: true })
    throw err
  }
  rmSync(targetPath, { recursive: true, force: true })
  renameSync(tmpPath, targetPath)

  // 更新来源元数据（保留原始 importedAt）
  const sourceWorkspace = listAgentWorkspaces().find((w) => w.slug === existingSource.sourceWorkspaceSlug)
  const updatedSource: SkillImportSource = {
    sourceWorkspaceSlug: existingSource.sourceWorkspaceSlug,
    sourceWorkspaceName: sourceWorkspace?.name ?? existingSource.sourceWorkspaceName,
    importedAt: existingSource.importedAt,
    sourceVersion: parseSkillVersion(sourcePath),
  }
  writeSkillImportSource(targetPath, updatedSource)

  const enabled = targetPath === activePath
  const content = readFileSync(join(targetPath, 'SKILL.md'), 'utf-8')
  const meta = parseSkillFrontmatter(content, actualSkillSlug, enabled)
  meta.importSource = updatedSource
  meta.hasUpdate = false

  console.log(`[Agent 工作区] 已从源更新 Skill: ${targetSlug}/${actualSkillSlug}`)
  return meta
}

// ===== Skill 来源追踪 helpers =====

const SOURCE_META_FILE = '.source.json'

function readSkillSource(skillDir: string): SkillImportSource | WorkspaceSkillSource | undefined {
  const p = join(skillDir, SOURCE_META_FILE)
  if (!existsSync(p)) return undefined
  try {
    const value = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SkillImportSource & WorkspaceSkillSource>
    if (value.scope === 'workspace') return value as WorkspaceSkillSource
    if (typeof value.sourceWorkspaceSlug === 'string' && typeof value.sourceVersion === 'string') {
      return value as SkillImportSource
    }
    return undefined
  } catch {
    return undefined
  }
}

function readSkillImportSource(skillDir: string): SkillImportSource | undefined {
  const source = readSkillSource(skillDir)
  return source && !isWorkspaceSkillSource(source) ? source : undefined
}

function isWorkspaceSkillSource(source: SkillImportSource | WorkspaceSkillSource): source is WorkspaceSkillSource {
  return 'scope' in source && source.scope === 'workspace'
}

function writeSkillImportSource(skillDir: string, source: SkillImportSource): void {
  writeSkillSource(skillDir, source)
}

function writeSkillSource(skillDir: string, source: SkillImportSource | WorkspaceSkillSource): void {
  writeFileSync(join(skillDir, SOURCE_META_FILE), JSON.stringify(source, null, 2), 'utf-8')
}

/** 在大小写敏感宿主上也按 Windows 目录语义定位 Skill。 */
function findSkillPathInRoot(root: string, skillSlug: string): string | null {
  const key = canonicalSkillSegmentKey(skillSlug)
  const entry = readdirSync(root, { withFileTypes: true })
    .find((candidate) => candidate.isDirectory()
      && !candidate.isSymbolicLink()
      && canonicalSkillSegmentKey(candidate.name) === key)
  if (!entry) return null
  assertSafeSkillSegment(entry.name, 'Skill slug')
  return join(root, entry.name)
}

/** 解析 Skill 所在目录（active 或 inactive），不存在则返回 null。 */
function resolveSkillDir(workspaceSlug: string, skillSlug: string): string | null {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  assertSafeSkillSegment(skillSlug, 'Skill slug')
  return findSkillPathInRoot(getWorkspaceSkillsDir(workspaceSlug), skillSlug)
    ?? findSkillPathInRoot(getInactiveSkillsDir(workspaceSlug), skillSlug)
}

export function readWorkspaceSkillContent(workspaceSlug: string, skillSlug: string): string {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const mdPath = join(dir, 'SKILL.md')
  if (!existsSync(mdPath)) throw new Error(`SKILL.md 不存在: ${mdPath}`)
  return readFileSync(mdPath, 'utf-8')
}

export function writeWorkspaceSkillContent(workspaceSlug: string, skillSlug: string, content: string): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 SKILL.md: ${workspaceSlug}/${skillSlug}`)
}

// ===== Skill 路由卡片（SKILL.json）=====

function workspaceSkillDirOrThrow(workspaceSlug: string, skillSlug: string): string {
  assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  return dir
}

function cardState(dir: string, skillSlug: string, removed: boolean): WorkspaceSkillCardState {
  const read = readSkillManifest(dir)
  return {
    present: removed ? false : read.present,
    ...(read.manifest ? { manifest: read.manifest } : {}),
    issues: read.issues,
    doctor: diagnoseSkill({ dir, slug: skillSlug }).filter(issue => issue.severity !== 'info'),
  }
}

export function readWorkspaceSkillCard(workspaceSlug: string, skillSlug: string): WorkspaceSkillCardState {
  return cardState(workspaceSkillDirOrThrow(workspaceSlug, skillSlug), skillSlug, false)
}

/**
 * 合并写入卡片；校验不过就报错不落盘（错误信息直接可展示给用户）。
 * 写成空内容时删除卡片，回到无卡片回退路径。
 */
export function writeWorkspaceSkillCard(workspaceSlug: string, skillSlug: string, patch: SkillManifestPatch): WorkspaceSkillCardState {
  const dir = workspaceSkillDirOrThrow(workspaceSlug, skillSlug)
  return cardState(dir, skillSlug, writeSkillManifest(dir, patch).removed)
}

// ===== Profer 工作区资料与记忆管理 =====

/**
 * 工作区资料文件名（相对 configDir）。
 *
 * - managed：`workspace-profile.md`（存量名，保持不变）
 * - project：`profile.md`（新名）；同目录旧名 `workspace-profile.md` 仅只读兼容
 *
 * 必须与系统提示词（agent-prompt-builder 的 `buildWorkspacePromptPaths`）一致，
 * 否则模型会被指到一个不存在的绝对路径。
 */
const MANAGED_WORKSPACE_PROFILE_FILE = 'workspace-profile.md'
const PROJECT_WORKSPACE_PROFILE_FILE = 'profile.md'
/** project 模式的旧资料名：只读兼容，写入一律走 `profile.md`。 */
const PROJECT_LEGACY_WORKSPACE_PROFILE_FILE = 'workspace-profile.md'
/** 历史版本曾把 managed 工作区资料写成 CLAUDE.md，仅用于兼容读取。 */
const LEGACY_WORKSPACE_PROFILE_FILE = 'CLAUDE.md'

/**
 * 工作区记忆目录名（相对 configDir）。
 *
 * - managed：`.profer/memory`（存量布局，保持不变）
 * - project：`memory`（configDir 已经是 `<root>/.profer`，再拼 `.profer` 会得到
 *   `<root>/.profer/.profer/memory`，正是 A3-2 遗留的 bug）
 */
const MANAGED_PROFER_MEMORY_DIR = '.profer/memory'
const PROJECT_PROFER_MEMORY_DIR = 'memory'
/** 旧版本使用 Claude 命名空间保存 Profer 工作区记忆，仅用于兼容迁移。 */
const LEGACY_PROFER_MEMORY_DIR = '.claude/memory'
const AUTO_MEMORY_INDEX = 'MEMORY.md'

function workspaceStorageMode(workspaceSlug: string): 'managed' | 'project' {
  return resolveWorkspaceLocation(workspaceSlug).mode === 'project' ? 'project' : 'managed'
}

function workspaceProfileFileName(workspaceSlug: string): string {
  return workspaceStorageMode(workspaceSlug) === 'project'
    ? PROJECT_WORKSPACE_PROFILE_FILE
    : MANAGED_WORKSPACE_PROFILE_FILE
}

function workspaceLegacyProfileFileName(workspaceSlug: string): string {
  return workspaceStorageMode(workspaceSlug) === 'project'
    ? PROJECT_LEGACY_WORKSPACE_PROFILE_FILE
    : LEGACY_WORKSPACE_PROFILE_FILE
}

function fileSummary(absPath: string): WorkspaceMemorySummary['workspaceProfile'] {
  if (!existsSync(absPath)) {
    return { exists: false, path: absPath, size: 0 }
  }
  const st = statSync(absPath)
  return {
    exists: st.isFile(),
    path: absPath,
    size: st.isFile() ? st.size : 0,
    updatedAt: st.mtimeMs,
  }
}

/** 工作区资料的写入目标：project = `.profer/profile.md`，managed = `workspace-profile.md`。 */
export function getWorkspaceProfilePath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), workspaceProfileFileName(workspaceSlug))
}

function getLegacyWorkspaceProfilePath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), workspaceLegacyProfileFileName(workspaceSlug))
}

/**
 * 读取优先新名、再回退旧名：
 * - project：`profile.md` → `workspace-profile.md`
 * - managed：`workspace-profile.md` → `CLAUDE.md`
 *
 * project 的 `CLAUDE.md` 位于 rootPath，属于用户项目指令，绝不当成 Profer 资料读取。
 */
function resolveWorkspaceProfileReadPath(workspaceSlug: string): string {
  const profilePath = getWorkspaceProfilePath(workspaceSlug)
  if (existsSync(profilePath)) return profilePath
  const legacyPath = getLegacyWorkspaceProfilePath(workspaceSlug)
  return existsSync(legacyPath) ? legacyPath : profilePath
}

function getWorkspaceAutoMemoryPath(workspaceSlug: string): string {
  const dirName = workspaceStorageMode(workspaceSlug) === 'project'
    ? PROJECT_PROFER_MEMORY_DIR
    : MANAGED_PROFER_MEMORY_DIR
  return join(getAgentWorkspacePath(workspaceSlug), dirName)
}

function getLegacyWorkspaceAutoMemoryPath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), LEGACY_PROFER_MEMORY_DIR)
}

/**
 * 将旧 `.claude/memory` 中尚未出现在新目录的文件复制到当前记忆目录。
 * 保留旧目录作为人工回滚/审计副本，不覆盖新目录中已经存在的文件。
 */
function mergeLegacyMemoryEntries(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return
  if (existsSync(targetDir)) {
    try {
      if (!statSync(targetDir).isDirectory()) return
    } catch {
      return
    }
  } else {
    mkdirSync(targetDir, { recursive: true })
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(target)) mkdirSync(target, { recursive: true })
      mergeLegacyMemoryEntries(source, target)
    } else if (entry.isFile() && !existsSync(target)) {
      try { cpSync(source, target) } catch (error) {
        console.warn(`[Agent 工作区] 迁移旧记忆文件失败 (${source}):`, error)
      }
    }
  }
}

function migrateLegacyWorkspaceMemory(workspaceSlug: string, targetDir: string): void {
  const legacyDir = getLegacyWorkspaceAutoMemoryPath(workspaceSlug)
  if (!existsSync(legacyDir)) return
  const targetExisted = existsSync(targetDir)
  mergeLegacyMemoryEntries(legacyDir, targetDir)
  if (!targetExisted) {
    console.log(`[Agent 工作区] 已兼容迁移旧记忆目录: ${legacyDir} → ${targetDir}（旧目录保留）`)
  }
}

export function getWorkspaceAutoMemoryDir(workspaceSlug: string): string {
  const dir = getWorkspaceAutoMemoryPath(workspaceSlug)
  migrateLegacyWorkspaceMemory(workspaceSlug, dir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function resolveAutoMemoryFilePath(memoryDir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('相对路径不能为空')
  }
  if (isAbsolute(relativePath)) {
    throw new Error('禁止传入绝对路径')
  }
  const normalized = relativePath.replace(/\\/g, '/')
  const resolved = resolve(memoryDir, normalized)
  const rel = relative(memoryDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('非法路径：禁止访问 auto memory 目录外')
  }
  // 防御 symlink 逃逸：字符串层面的 relative 检查无法识别目录内指向外部的软链接。
  // 对真实存在的最近祖先做 realpath 校验，确保解析后仍落在 memoryDir 之内。
  const memoryRealDir = existsSync(memoryDir) ? realpathSync(memoryDir) : memoryDir
  let probe = resolved
  while (probe !== memoryDir && !existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  if (existsSync(probe)) {
    const realProbe = realpathSync(probe)
    const realRel = relative(memoryRealDir, realProbe)
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error('非法路径：禁止通过软链接访问 auto memory 目录外')
    }
  }
  return resolved
}

function collectAutoMemorySummary(memoryDir: string): WorkspaceMemorySummary['autoMemory'] {
  let fileCount = 0
  let totalSize = 0
  let updatedAt: number | undefined

  const walk = (dir: string, depth: number): void => {
    if (depth > SKILL_TREE_MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absPath, depth + 1)
      } else if (entry.isFile()) {
        const st = statSync(absPath)
        if (isLikelyBinaryFile(absPath, st.size)) continue
        fileCount += 1
        totalSize += st.size
        updatedAt = updatedAt == null ? st.mtimeMs : Math.max(updatedAt, st.mtimeMs)
      }
    }
  }

  walk(memoryDir, 0)
  return {
    directory: memoryDir,
    indexExists: existsSync(join(memoryDir, AUTO_MEMORY_INDEX)),
    fileCount,
    totalSize,
    updatedAt,
  }
}

function buildMemoryFileTree(rootDir: string, currentDir: string, depth: number): SkillFileNode[] {
  if (depth > SKILL_TREE_MAX_DEPTH) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: SkillFileNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absPath = join(currentDir, entry.name)
    const rel = relative(rootDir, absPath).split(/[\\/]/).join('/')

    if (entry.isDirectory()) {
      nodes.push({
        relativePath: rel,
        name: entry.name,
        type: 'directory',
        children: buildMemoryFileTree(rootDir, absPath, depth + 1),
      })
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = statSync(absPath).size
      } catch {
        // ignore
      }
      nodes.push({
        relativePath: rel,
        name: entry.name,
        type: 'file',
        size,
        isText: !isLikelyBinaryFile(absPath, size),
      })
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    if (a.relativePath === AUTO_MEMORY_INDEX) return -1
    if (b.relativePath === AUTO_MEMORY_INDEX) return 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export function getWorkspaceMemorySummary(workspaceSlug: string): WorkspaceMemorySummary {
  const memoryDir = getWorkspaceAutoMemoryDir(workspaceSlug)
  const profilePath = resolveWorkspaceProfileReadPath(workspaceSlug)
  const profileSummary = fileSummary(profilePath)
  return {
    workspaceProfile: {
      ...profileSummary,
      // 旧 CLAUDE.md 只作为读取来源；写入 API 始终落到新的 Profer profile。
      path: profilePath,
    },
    autoMemory: {
      ...collectAutoMemorySummary(memoryDir),
      memoryArchivePath: getWorkspaceMemoryArchivePath(workspaceSlug),
    },
  }
}

export function readWorkspaceProfile(workspaceSlug: string): SkillFileContent {
  const abs = resolveWorkspaceProfileReadPath(workspaceSlug)
  if (!existsSync(abs)) {
    // 无文件时 virtual 名与写入目标一致，UI 显示的文件名不会与实际落盘名冲突。
    return { relativePath: workspaceProfileFileName(workspaceSlug), isText: true, size: 0, content: '' }
  }
  const st = statSync(abs)
  const fileName = basename(abs)
  if (!st.isFile()) throw new Error(`${fileName} 不是文件`)
  if (st.size > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }
  const binary = isLikelyBinaryFile(abs, st.size)
  return {
    relativePath: fileName,
    isText: !binary,
    size: st.size,
    content: binary ? undefined : readFileSync(abs, 'utf-8'),
  }
}

export function writeWorkspaceProfile(workspaceSlug: string, content: string): void {
  const byteLen = Buffer.byteLength(content, 'utf-8')
  if (byteLen > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`内容过大（${(byteLen / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }
  writeFileSync(getWorkspaceProfilePath(workspaceSlug), content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 Profer 工作区资料 (${workspaceProfileFileName(workspaceSlug)}): ${workspaceSlug}`)
}

export function listWorkspaceAutoMemoryFiles(workspaceSlug: string): SkillFileNode[] {
  const dir = getWorkspaceAutoMemoryDir(workspaceSlug)
  return buildMemoryFileTree(dir, dir, 0)
}

export function readWorkspaceAutoMemoryFile(workspaceSlug: string, relativePath: string): SkillFileContent {
  const dir = getWorkspaceAutoMemoryDir(workspaceSlug)
  const abs = resolveAutoMemoryFilePath(dir, relativePath)
  if (!existsSync(abs) && relativePath === AUTO_MEMORY_INDEX) {
    return { relativePath: AUTO_MEMORY_INDEX, isText: true, size: 0, content: '' }
  }
  if (!existsSync(abs)) throw new Error(`文件不存在: ${relativePath}`)

  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`目标不是文件: ${relativePath}`)
  if (st.size > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }

  const binary = isLikelyBinaryFile(abs, st.size)
  return {
    relativePath: relative(dir, abs).split(/[\\/]/).join('/'),
    isText: !binary,
    size: st.size,
    content: binary ? undefined : readFileSync(abs, 'utf-8'),
  }
}

export function writeWorkspaceAutoMemoryFile(workspaceSlug: string, relativePath: string, content: string): void {
  const dir = getWorkspaceAutoMemoryDir(workspaceSlug)
  const abs = resolveAutoMemoryFilePath(dir, relativePath)
  const byteLen = Buffer.byteLength(content, 'utf-8')
  if (byteLen > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`内容过大（${(byteLen / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }
  const parent = dirname(abs)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  writeFileSync(abs, content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 auto memory 文件: ${workspaceSlug}/${relativePath}`)
}

// ===== memory-archive 主题记忆目录管理 =====

/** 旧版专题记忆目录（只读展示用，不再作为写入落点）。 */
export function getLegacyMemoryArchivePath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), 'workspace-files', '.context', 'memory-archive')
}

/** 迁移完成标记：迁移只做一次，避免用户删除迁移后的文件又被旧目录复活（P2-5）。 */
const MEMORY_ARCHIVE_MIGRATION_MARKER = '.memory-archive-migrated'

/**
 * memory 主题记忆目录（统一目录）绝对路径。
 *
 * Claude SDK 的 `autoMemoryDirectory` 与 Pi 的文件记忆读写同一份 `MEMORY.md` + 主题文件。
 * 历史落点是 `workspace-files/.context/memory-archive/`，首次解析时复制过来（不覆盖、不删除），
 * 之后靠 marker 保证不再重复迁移。
 */
export function getWorkspaceMemoryArchivePath(workspaceSlug: string): string {
  const dir = getWorkspaceAutoMemoryDir(workspaceSlug)
  const marker = join(dir, MEMORY_ARCHIVE_MIGRATION_MARKER)
  if (!existsSync(marker)) {
    const legacyDir = getLegacyMemoryArchivePath(workspaceSlug)
    if (existsSync(legacyDir)) mergeLegacyMemoryEntries(legacyDir, dir)
    try {
      writeFileSync(marker, new Date().toISOString(), 'utf-8')
    } catch (error) {
      console.warn('[Agent 工作区] 写入记忆迁移标记失败:', error)
    }
  }
  return dir
}

/** UI「历史档案」面板：只展示旧目录，避免与统一目录重复列出同一批文件。 */
export function listWorkspaceMemoryArchiveFiles(workspaceSlug: string): SkillFileNode[] {
  const dir = getLegacyMemoryArchivePath(workspaceSlug)
  if (!existsSync(dir)) return []
  return buildMemoryFileTree(dir, dir, 0)
}

export function readWorkspaceMemoryArchiveFile(workspaceSlug: string, relativePath: string): SkillFileContent {
  const dir = getLegacyMemoryArchivePath(workspaceSlug)
  const abs = resolveAutoMemoryFilePath(dir, relativePath)
  if (!existsSync(abs)) throw new Error(`文件不存在: ${relativePath}`)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`目标不是文件: ${relativePath}`)
  if (st.size > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }
  const binary = isLikelyBinaryFile(abs, st.size)
  return {
    relativePath: relative(dir, abs).split(/[\\/]/).join('/'),
    isText: !binary,
    size: st.size,
    content: binary ? undefined : readFileSync(abs, 'utf-8'),
  }
}

export function writeWorkspaceMemoryArchiveFile(workspaceSlug: string, relativePath: string, content: string): void {
  // 统一目录是唯一写入落点；旧目录只读展示，不再写入。
  const dir = getWorkspaceMemoryArchivePath(workspaceSlug)
  const abs = resolveAutoMemoryFilePath(dir, relativePath)
  const byteLen = Buffer.byteLength(content, 'utf-8')
  if (byteLen > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`内容过大（${(byteLen / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }
  const parent = dirname(abs)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  writeFileSync(abs, content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 memory-archive 文件: ${workspaceSlug}/${relativePath}`)
}

// ===== Skill 子文件管理 =====

/** 单个子文件大小上限（10 MB），超过则拒绝读入到编辑器 */
const SKILL_FILE_SIZE_LIMIT = 10 * 1024 * 1024
/** 文件树递归深度上限，防止异常深嵌套 */
const SKILL_TREE_MAX_DEPTH = 8

/** 把相对路径限制在 Skill 根目录内，并拒绝直接覆盖 SKILL.md */
function resolveSkillChildPath(skillDir: string, relativePath: string, opts: { allowSkillMd?: boolean } = {}): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('相对路径不能为空')
  }
  if (isAbsolute(relativePath)) {
    throw new Error('禁止传入绝对路径')
  }
  const normalized = relativePath.replace(/\\/g, '/')
  const resolved = resolve(skillDir, normalized)
  const rel = relative(skillDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('非法路径：禁止访问 Skill 目录外')
  }
  // 用 lowercase 比较，避免 macOS/Windows 的大小写不敏感文件系统上 skill.md/Skill.MD 绕过保护
  if (!opts.allowSkillMd && rel.split(/[\\/]/).join('/').toLowerCase() === 'skill.md') {
    throw new Error('SKILL.md 由专用接口管理，请通过 readWorkspaceSkillContent / writeWorkspaceSkillContent')
  }
  return resolved
}

/** 用文件头判断是否为二进制文件（粗略：含 NUL 字节即视为二进制）。只读前 8KB，避免把大文件全量读入内存 */
function isLikelyBinaryFile(absPath: string, size: number): boolean {
  if (size === 0) return false
  let fd: number | undefined
  try {
    fd = openSync(absPath, 'r')
    const buf = Buffer.alloc(Math.min(size, 8192))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } catch {
    return true
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function buildSkillFileTree(rootDir: string, currentDir: string, depth: number): SkillFileNode[] {
  if (depth > SKILL_TREE_MAX_DEPTH) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: SkillFileNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 跳过隐藏文件，如 .source.json
    const absPath = join(currentDir, entry.name)
    const rel = relative(rootDir, absPath).split(/[\\/]/).join('/')

    if (rel === 'SKILL.md') continue // SKILL.md 由主编辑器管理

    const isDir = entry.isDirectory()
    if (isDir) {
      nodes.push({
        relativePath: rel,
        name: entry.name,
        type: 'directory',
        children: buildSkillFileTree(rootDir, absPath, depth + 1),
      })
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = statSync(absPath).size
      } catch {
        // ignore
      }
      nodes.push({
        relativePath: rel,
        name: entry.name,
        type: 'file',
        size,
        isText: !isLikelyBinaryFile(absPath, size),
      })
    }
  }

  // 目录优先 + 名称升序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export function listSkillFiles(workspaceSlug: string, skillSlug: string): SkillFileNode[] {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  return buildSkillFileTree(dir, dir, 0)
}

export function readSkillFile(workspaceSlug: string, skillSlug: string, relativePath: string): SkillFileContent {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)
  if (!existsSync(abs)) throw new Error(`文件不存在: ${relativePath}`)

  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`目标不是文件: ${relativePath}`)
  if (st.size > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }

  const binary = isLikelyBinaryFile(abs, st.size)
  return {
    relativePath: relative(dir, abs).split(/[\\/]/).join('/'),
    isText: !binary,
    size: st.size,
    content: binary ? undefined : readFileSync(abs, 'utf-8'),
  }
}

export function writeSkillFile(workspaceSlug: string, skillSlug: string, relativePath: string, content: string): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)

  const byteLen = Buffer.byteLength(content, 'utf-8')
  if (byteLen > SKILL_FILE_SIZE_LIMIT) {
    throw new Error(`内容过大（${(byteLen / 1024 / 1024).toFixed(2)} MB），超过 10 MB 限制`)
  }

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    throw new Error(`目标是目录，无法写入文件内容: ${relativePath}`)
  }

  // 自动创建父目录
  const parent = dirname(abs)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }

  writeFileSync(abs, content, 'utf-8')
  console.log(`[Agent 工作区] 已更新 Skill 子文件: ${workspaceSlug}/${skillSlug}/${relativePath}`)
}

export function createSkillEntry(
  workspaceSlug: string,
  skillSlug: string,
  relativePath: string,
  type: 'file' | 'directory',
): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)

  if (existsSync(abs)) {
    throw new Error(`目标已存在: ${relativePath}`)
  }

  if (type === 'directory') {
    mkdirSync(abs, { recursive: true })
  } else {
    const parent = dirname(abs)
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true })
    }
    writeFileSync(abs, '', 'utf-8')
  }
  console.log(`[Agent 工作区] 已创建 Skill 子${type === 'directory' ? '目录' : '文件'}: ${workspaceSlug}/${skillSlug}/${relativePath}`)
}

export function deleteSkillEntry(workspaceSlug: string, skillSlug: string, relativePath: string): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const abs = resolveSkillChildPath(dir, relativePath)
  if (!existsSync(abs)) {
    throw new Error(`目标不存在: ${relativePath}`)
  }
  rmSync(abs, { recursive: true, force: true })
  console.log(`[Agent 工作区] 已删除 Skill 子项: ${workspaceSlug}/${skillSlug}/${relativePath}`)
}

export function renameSkillEntry(
  workspaceSlug: string,
  skillSlug: string,
  fromRelative: string,
  toRelative: string,
): void {
  const dir = resolveSkillDir(workspaceSlug, skillSlug)
  if (!dir) throw new Error(`Skill 不存在: ${workspaceSlug}/${skillSlug}`)
  const fromAbs = resolveSkillChildPath(dir, fromRelative)
  const toAbs = resolveSkillChildPath(dir, toRelative)
  if (!existsSync(fromAbs)) {
    throw new Error(`源不存在: ${fromRelative}`)
  }
  if (existsSync(toAbs)) {
    throw new Error(`目标已存在: ${toRelative}`)
  }
  const parent = dirname(toAbs)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  renameSync(fromAbs, toAbs)
  console.log(`[Agent 工作区] Skill 子项重命名: ${workspaceSlug}/${skillSlug}: ${fromRelative} → ${toRelative}`)
}

/** 简单 semver 比较：a 是否比 b 更新 */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

// ===== 工作区类型筛选 =====

/** 列出个人工作区 */
export function listWorkspacesByType(type: 'personal'): AgentWorkspace[] {
  const index = readIndex()
  return index.workspaces.filter((w) => (w.type ?? 'personal') === type && !w.isDeleted)
}

// ===== 工作区配置管理 =====

interface WorkspaceConfig {
  attachedDirectories?: string[]
  attachedFiles?: string[]
  worktreeRepos?: import('@profer/shared').WorkspaceWorktreeRepo[]
}

function getWorkspaceConfigPath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), 'config.json')
}

function readWorkspaceConfig(workspaceSlug: string): WorkspaceConfig {
  const configPath = getWorkspaceConfigPath(workspaceSlug)

  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const data = JSON.parse(raw) as Partial<WorkspaceConfig>
    return {
      attachedDirectories: Array.isArray(data.attachedDirectories)
        ? data.attachedDirectories.filter((dir): dir is string => typeof dir === 'string')
        : undefined,
      attachedFiles: Array.isArray(data.attachedFiles)
        ? data.attachedFiles.filter((file): file is string => typeof file === 'string')
        : undefined,
      worktreeRepos: Array.isArray(data.worktreeRepos)
        ? data.worktreeRepos.filter((r) => r && typeof r.name === 'string' && typeof r.repoPath === 'string' && typeof r.worktreesPath === 'string')
        : undefined,
    }
  } catch {
    return {}
  }
}

function writeWorkspaceConfig(workspaceSlug: string, config: WorkspaceConfig): void {
  const configPath = getWorkspaceConfigPath(workspaceSlug)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

// ===== 工作区级附加目录管理 =====

export function getWorkspaceAttachedDirectories(workspaceSlug: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  return config.attachedDirectories ?? []
}

export function attachWorkspaceDirectory(workspaceSlug: string, directoryPath: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedDirectories ?? []

  if (existing.includes(directoryPath)) {
    return existing
  }

  const updated = [...existing, directoryPath]
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedDirectories: updated })
  console.log(`[Agent 工作区] 已附加工作区目录: ${directoryPath} → ${workspaceSlug}`)
  return updated
}

export function detachWorkspaceDirectory(workspaceSlug: string, directoryPath: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedDirectories ?? []
  const updated = existing.filter((d) => d !== directoryPath)
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedDirectories: updated })
  console.log(`[Agent 工作区] 已移除工作区目录: ${directoryPath} ← ${workspaceSlug}`)
  return updated
}

// ===== 工作区级附加文件管理 =====

export function getWorkspaceAttachedFiles(workspaceSlug: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  return config.attachedFiles ?? []
}

export function attachWorkspaceFile(workspaceSlug: string, filePath: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedFiles ?? []

  if (existing.includes(filePath)) {
    return existing
  }

  const updated = [...existing, filePath]
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedFiles: updated })
  console.log(`[Agent 工作区] 已附加工作区文件: ${filePath} → ${workspaceSlug}`)
  return updated
}

export function detachWorkspaceFile(workspaceSlug: string, filePath: string): string[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.attachedFiles ?? []
  const updated = existing.filter((f) => f !== filePath)
  writeWorkspaceConfig(workspaceSlug, { ...config, attachedFiles: updated })
  console.log(`[Agent 工作区] 已移除工作区文件: ${filePath} ← ${workspaceSlug}`)
  return updated
}

// ===== 工作区级 Worktree 仓库管理 =====

/**
 * 获取工作区的 Worktree 仓库列表。
 *
 * 优先从工作区的「附加目录」中自动探测 git 仓库根，避免依赖手动维护的
 * worktreeRepos 配置（其 repoPath 容易因仓库移动而失效，导致 WorktreeSelector
 * 静默找不到 worktree）。同时保留 config 中仍然存在的手动配置项（如不在附加
 * 目录内的额外仓库），并自动过滤掉路径已不存在的陈旧条目。
 */
export async function getWorktreeRepos(workspaceSlug: string): Promise<import('@profer/shared').WorkspaceWorktreeRepo[]> {
  const config = readWorkspaceConfig(workspaceSlug)

  // repoPath 归一化后去重
  const byPath = new Map<string, import('@profer/shared').WorkspaceWorktreeRepo>()

  // 1. 从附加目录自动探测 git 仓库根
  const attachedDirs = config.attachedDirectories ?? []
  for (const dir of attachedDirs) {
    let roots: string[]
    try {
      roots = await findAllGitRoots(dir)
    } catch {
      continue
    }
    for (const root of roots) {
      if (!byPath.has(root)) {
        byPath.set(root, {
          name: basename(root),
          repoPath: root,
          worktreesPath: '',
          priority: 1,
        })
      }
    }
  }

  // 2. 合并手动配置中仍然存在的仓库（自动过滤失效路径）
  for (const repo of config.worktreeRepos ?? []) {
    const normalized = normalizeGitRoot(repo.repoPath)
    if (!byPath.has(normalized) && existsSync(repo.repoPath)) {
      byPath.set(normalized, repo)
    }
  }

  return Array.from(byPath.values()).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
}

export function addWorktreeRepo(workspaceSlug: string, repo: import('@profer/shared').WorkspaceWorktreeRepo): import('@profer/shared').WorkspaceWorktreeRepo[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.worktreeRepos ?? []

  if (existing.some((r) => r.repoPath === repo.repoPath)) {
    return existing
  }

  const updated = [...existing, repo]
  writeWorkspaceConfig(workspaceSlug, { ...config, worktreeRepos: updated })
  console.log(`[Agent 工作区] 已添加 worktree 仓库: ${repo.name} (${repo.repoPath}) → ${workspaceSlug}`)
  return updated
}

export function removeWorktreeRepo(workspaceSlug: string, repoPath: string): import('@profer/shared').WorkspaceWorktreeRepo[] {
  const config = readWorkspaceConfig(workspaceSlug)
  const existing = config.worktreeRepos ?? []
  const updated = existing.filter((r) => r.repoPath !== repoPath)
  writeWorkspaceConfig(workspaceSlug, { ...config, worktreeRepos: updated })
  console.log(`[Agent 工作区] 已移除 worktree 仓库: ${repoPath} ← ${workspaceSlug}`)
  return updated
}

/**
 * 清理所有工作区中不存在的附加目录和附加文件
 * @returns 清理的条目总数
 */
export function cleanupStaleWorkspaceAttachedPaths(): number {
  const workspaces = listAgentWorkspaces()
  let count = 0

  for (const ws of workspaces) {
    const config = readWorkspaceConfig(ws.slug)
    let changed = false

    if (config.attachedDirectories?.length) {
      const valid = config.attachedDirectories.filter((d) => existsSync(d))
      if (valid.length < config.attachedDirectories.length) {
        count += config.attachedDirectories.length - valid.length
        config.attachedDirectories = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (config.attachedFiles?.length) {
      const valid = config.attachedFiles.filter((f) => existsSync(f))
      if (valid.length < config.attachedFiles.length) {
        count += config.attachedFiles.length - valid.length
        config.attachedFiles = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (changed) {
      writeWorkspaceConfig(ws.slug, config)
    }
  }

  if (count > 0) {
    console.log(`[Agent 工作区] 清理了 ${count} 个不存在的附加路径`)
  }

  return count
}
