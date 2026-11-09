/**
 * 工作区 Shadow Git 的 Electron 侧装配。
 *
 * 这一层只回答三个问题：
 * 1. 一个工作区的 shadow repository 放在哪（Profer 配置目录，绝不进用户项目）；
 * 2. 这个工作区当前有哪些根目录需要纳入（主根 + 工作区级附加目录）；
 * 3. 哪些绝对路径必须排除（shadow 自身、项目 .profer 等 Profer 私有数据）。
 *
 * Phase 0 刻意**不在任何运行时路径上调用 capture**：底座先能建立、能重启读回，
 * 等 Phase 1 再把「首次启用 / turn 前后 / 回退前」的采集点接上。这样不会在
 * 旧回退链路还在服役时改变任何用户可见行为。
 *
 * 已知边界（Phase 1 处理）：
 * - managed 模式下会话目录 `<工作区根>/<sessionId>` 同时承载 Agent 工作文件和
 *   Profer 会话产物；本阶段只靠目录名排除（.context/.claude/.profer），
 *   尚未按会话把 JSONL 等产物逐项排除。
 * - 会话级附加目录（sessionMeta.attachedDirectories）随会话变化，属于 Phase 2
 *   的 turn 归属范围，这里只纳入工作区级附加目录。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentWorkspace } from '@profer/shared'
import {
  WorkspaceShadowRepository,
  deriveAttachedRootId,
  isWithinPath,
  normalizeShadowRoots,
  runWorkspaceShadowTask,
  type ShadowCaptureReason,
  type ShadowCaptureResult,
  type ShadowRoot,
  type ShadowWorkspaceState,
} from '@profer/session-store'
import { getAgentWorkspace, getWorkspaceAttachedDirectories } from './agent-workspace-manager'
import { getConfigDir } from './config-paths'
import { findGitPath } from './git-detector'
import { workspaceShadowExclusions } from './workspace-shadow-exclusions'
import { canonicalizeWorkspaceRootPath, resolveWorkspaceLocation } from './workspace-locator'

/** `<配置根>/workspace-shadow/<workspaceId>/` */
export const WORKSPACE_SHADOW_DIR_NAME = 'workspace-shadow'
/** 每个工作区一个 bare 仓库；目录名固定，便于磁盘统计与清理。 */
export const WORKSPACE_SHADOW_REPO_DIR_NAME = 'repo.git'
export const WORKSPACE_SHADOW_JOURNAL_NAME = 'journal.json'

/**
 * 工作区 id 直接参与目录名，必须先证明它只是一个安全路径段。
 *
 * 用 UUID 的字符集限制而不是「删除危险字符」：发现异常 id 时应当拒绝，
 * 不能悄悄把它映射到另一个目录上。
 */
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/

export function isSafeWorkspaceShadowId(workspaceId: string): boolean {
  return SAFE_WORKSPACE_ID.test(workspaceId) && !workspaceId.includes('..')
}

function requireWorkspace(workspaceId: string): AgentWorkspace {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error(`[Shadow Git] 工作区不存在: ${workspaceId}`)
  return workspace
}

export function getWorkspaceShadowDir(workspaceId: string): string {
  if (!isSafeWorkspaceShadowId(workspaceId)) {
    throw new Error(`[Shadow Git] 工作区 id 不能作为目录名: ${workspaceId}`)
  }
  return join(getConfigDir(), WORKSPACE_SHADOW_DIR_NAME, workspaceId)
}

export function getWorkspaceShadowRepoDir(workspaceId: string): string {
  return join(getWorkspaceShadowDir(workspaceId), WORKSPACE_SHADOW_REPO_DIR_NAME)
}

export function getWorkspaceShadowJournalPath(workspaceId: string): string {
  return join(getWorkspaceShadowDir(workspaceId), WORKSPACE_SHADOW_JOURNAL_NAME)
}

/**
 * 解析工作区当前的根集合。
 *
 * - 主根 = 工作区的真实根（project 模式是项目根，managed 模式是工作区目录）；
 * - 附加根 = 工作区级 config.json 里的 attachedDirectories；
 * - 嵌套在主根里的附加目录会被丢弃，避免同一份文件在两个命名空间里出现两份。
 *
 * 不 throw：索引缺失或项目根已不可用时，交给 walk 产出 root-missing 记录。
 */
export function resolveWorkspaceShadowRoots(
  workspace: AgentWorkspace,
  options: { sessionAttachedDirectories?: string[] } = {},
): ShadowRoot[] {
  const location = resolveWorkspaceLocation(workspace.slug)
  // 根必须先 realpath：macOS 的 /var 是 /private/var 的链接，同一目录两种写法会让
  // 「附加目录是否嵌在主根内」的判定失效，也会让 rootId 在两种写法间抖动。
  const primaryRootPath = safeCanonical(location.rootPath)
  const primary: ShadowRoot = {
    rootId: workspace.id,
    rootPath: primaryRootPath,
    kind: location.mode,
  }
  const attachedPaths: string[] = []
  try {
    attachedPaths.push(...getWorkspaceAttachedDirectories(workspace.slug))
  } catch {
    // 配置损坏不应该让整个底座不可用；主根仍然值得记录。
  }
  // 会话级附加目录：只在这一轮/这个会话里可见，因此根集合会随会话变化。
  // 归属记录必须同时存根快照，否则回退时无法把 rootId 还原成真实路径。
  attachedPaths.push(...(options.sessionAttachedDirectories ?? []))
  const attached: ShadowRoot[] = attachedPaths.map((rootPath) => {
    const canonical = safeCanonical(rootPath)
    return {
      rootId: deriveAttachedRootId(canonical),
      rootPath: canonical,
      kind: 'attached' as const,
    }
  })
  const nestedInsidePrimary = attached.filter((root) => isWithinPath(primary.rootPath, root.rootPath))
  const usable = attached.filter(
    (root) => !isWithinPath(primary.rootPath, root.rootPath) && root.rootPath !== primary.rootPath,
  )
  if (nestedInsidePrimary.length > 0) {
    console.warn(`[Shadow Git] 忽略 ${nestedInsidePrimary.length} 个嵌套在主根内的附加目录`)
  }
  return normalizeShadowRoots([primary, ...usable])
}

/** realpath 失败（目录暂不存在）时退回 resolve：不能因为根不存在就丢掉整个根集合。 */
function safeCanonical(pathValue: string): string {
  try {
    return canonicalizeWorkspaceRootPath(pathValue)
  } catch {
    return pathValue
  }
}

/**
 * 必须排除的绝对路径。
 *
 * 只排除 Profer 自己写的东西：shadow 仓库、项目内 `.profer/`（会话数据与配置）。
 * 用户项目根下的 `.git` 由目录名规则排除，不在这里列——列出它会掩盖误配置。
 */
export function collectWorkspaceShadowExclusions(workspace: AgentWorkspace): string[] {
  const location = resolveWorkspaceLocation(workspace.slug)
  return [
    getWorkspaceShadowDir(workspace.id),
    ...workspaceShadowExclusions({ storageMode: location.mode, rootPath: safeCanonical(location.rootPath) }),
  ]
}

export interface OpenWorkspaceShadowInput {
  workspace: AgentWorkspace
  /** 每次采集重新求值的排除路径；缺省用 collectWorkspaceShadowExclusions。 */
  excludeAbsolutePaths?: () => string[]
  limits?: { maxFileBytes?: number; maxTotalBytes?: number; maxEntries?: number }
}

/**
 * 打开（必要时初始化）工作区 shadow repository。
 *
 * git 不可用或工作区身份不安全时返回 null，由调用方决定是否降级；
 * 这里不向用户暴露任何错误文案。
 */
export async function openWorkspaceShadowRepository(
  input: OpenWorkspaceShadowInput,
): Promise<WorkspaceShadowRepository | null> {
  const { workspace } = input
  if (!isSafeWorkspaceShadowId(workspace.id)) {
    console.warn(`[Shadow Git] 工作区 id 不安全，跳过: ${workspace.id}`)
    return null
  }
  const gitPath = findGitPath()
  if (!gitPath) return null

  const dir = getWorkspaceShadowDir(workspace.id)
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      console.warn('[Shadow Git] 无法创建工作区底座目录:', error)
      return null
    }
  }

  try {
    return await WorkspaceShadowRepository.open({
      workspaceId: workspace.id,
      repoDir: getWorkspaceShadowRepoDir(workspace.id),
      journalPath: getWorkspaceShadowJournalPath(workspace.id),
      gitPath,
      tempDir: join(dir, 'tmp'),
      limits: input.limits,
      excludeAbsolutePaths: input.excludeAbsolutePaths ?? (() => collectWorkspaceShadowExclusions(workspace)),
    })
  } catch (error) {
    console.warn('[Shadow Git] 工作区底座初始化失败:', error)
    return null
  }
}

export interface CaptureWorkspaceShadowInput extends OpenWorkspaceShadowInput {
  reason: ShadowCaptureReason
  /** 显式传入工作区，便于在只有 id 的调用点复用。 */
  workspaceId?: string
  /** 会话级附加目录；缺省按工作区级配置解析。 */
  sessionAttachedDirectories?: string[]
  /**
   * 直接指定根集合。
   *
   * 只有调用方已经算好根（例如要在记录里保留同一份快照）时才传：
   * 两次解析之间根可能变化，采一份、记另一份会让归属记录的路径含义失真。
   */
  roots?: ShadowRoot[]
}

/**
 * 采集一次工作区状态。
 *
 * 失败返回 null（并已写 journal），不 throw：采集是旁路事实记录，
 * 不能因为磁盘或 git 异常打断 Agent turn。
 */
export function captureWorkspaceShadow(
  input: CaptureWorkspaceShadowInput,
): Promise<ShadowCaptureResult | null> {
  const workspace = input.workspaceId ? requireWorkspace(input.workspaceId) : input.workspace
  // 排队登记必须同步发生：「打开仓库」本身也要排进队列，否则端到端 replay 的
  // pending 计数会晚几十毫秒，下一轮 turn 就会误以为队列空闲而与本轮写入交叠。
  return runWorkspaceShadowTask(workspace.id, async () => {
    const repository = await openWorkspaceShadowRepository({ ...input, workspace })
    if (!repository) return null
    const roots =
      input.roots ??
      resolveWorkspaceShadowRoots(workspace, {
        ...(input.sessionAttachedDirectories ? { sessionAttachedDirectories: input.sessionAttachedDirectories } : {}),
      })
    if (roots.length === 0) return null
    return repository.captureExclusive({ reason: input.reason, roots })
  })
}

/** 重启后读回工作区底座的当前状态；仓库尚未建立时返回 null。 */
export async function readWorkspaceShadowState(workspaceId: string): Promise<ShadowWorkspaceState | null> {
  const workspace = requireWorkspace(workspaceId)
  const repository = await openWorkspaceShadowRepository({ workspace })
  if (!repository) return null
  return repository.readState()
}
