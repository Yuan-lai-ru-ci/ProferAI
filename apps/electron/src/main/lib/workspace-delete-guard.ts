/**
 * 工作区删除守卫（不变量 I2）
 *
 * I2：project 工作区的 `rootPath` 及其内部**任何**生命周期删除都不得触碰。
 * 这里提供两层护栏，二者都是纯函数 + 只读索引，可在任意删除点显式调用：
 *
 * 1. `assertNotProjectLifecyclePath(targetPath)`
 *    生命周期删除（删工作区 / 删会话 / 迁移 / fork 回滚清理）的硬护栏：
 *    目标等于某个 project 的 rootPath，或位于其内部 → 直接抛错。
 *
 * 2. `assertProjectFileDeletionAllowed(targetPath, workspace)`
 *    文件浏览器里的删除 / 改名 / 移动：允许操作普通项目文件，
 *    但禁止删项目根、禁止删项目根的祖先、禁止整体删 `<rootPath>/.profer`。
 *
 * 依赖方向：只依赖 `workspace-locator`（只读索引 + 纯路径归一化）。
 * **不得** import `agent-workspace-manager`：manager 需要 import 本模块，
 * 反向引用会形成环，也会把「守卫」变成「管理器语义」的从属物。
 */

import { basename, dirname, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { AgentWorkspace } from '@profer/shared'
import { canonicalizeWorkspaceRootPath, listProjectWorkspaceRoots, resolveWorkspaceLocation } from './workspace-locator'

/** project 路径被删除守卫拦截。调用方应把它当作「不可恢复的操作」处理，而不是可忽略的 IO 错误。 */
export class ProjectPathDeletionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectPathDeletionError'
  }
}

/** 守卫只需要工作区的这三个字段，避免调用方为了调用守卫去构造完整 `AgentWorkspace`。 */
export type ProjectWorkspaceRef = Pick<AgentWorkspace, 'slug' | 'rootPath' | 'storageMode'>

/** 拼接安全前缀：文件系统根 `/` 不再补分隔符（否则会得到 `//`）。 */
function withTrailingSep(dirPath: string): string {
  return dirPath.endsWith(sep) ? dirPath : `${dirPath}${sep}`
}

/** `target` 是否等于 `root` 或位于 `root` 之内（两者都必须已归一化）。 */
function isSameOrInside(target: string, root: string): boolean {
  return target === root || target.startsWith(withTrailingSep(root))
}

/**
 * 守卫专用归一化：路径不存在时 realpath 最近的已存在祖先，再拼回剩余段。
 *
 * `canonicalizeWorkspaceRootPath` 对不存在路径退化为 `resolve`，在 `/var → /private/var`
 * 这类符号链接下会与已 realpath 的 rootPath 前缀不一致，导致守卫漏判。
 * 这里只影响守卫的比较，不改变索引落盘值。
 */
function canonicalizeForGuard(targetPath: string): string {
  try {
    return realpathSync(targetPath)
  } catch { /* 不存在：继续找祖先 */ }
  const resolved = resolve(targetPath)
  const tail: string[] = []
  let current = resolved
  while (current !== dirname(current)) {
    try {
      const real = realpathSync(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch {
      tail.push(basename(current))
      current = dirname(current)
    }
  }
  return resolved
}

/**
 * 生命周期删除的硬护栏。
 *
 * 遍历所有 project 工作区的 rootPath：`target === root` 或 `target` 在 root 之内 → 抛错。
 * 路径先 realpath（不存在时退化为 `resolve`），避免符号链接绕过前缀判定。
 *
 * 唯一豁免：`<rootPath>/.profer/sessions/<sid>` 及其子路径。会话运行时数据已迁到项目内，
 * 属于 Profer 私有数据，删会话/迁移/fork 回滚必须能清理；但整个 `sessions/` 容器、
 * `.profer` 与项目根本身仍受保护。
 */
export function assertNotProjectLifecyclePath(targetPath: string): void {
  const target = canonicalizeForGuard(targetPath)
  for (const project of listProjectWorkspaceRoots()) {
    if (!isSameOrInside(target, canonicalizeForGuard(project.rootPath))) continue
    const configDir = canonicalizeForGuard(resolveWorkspaceLocation(project.slug).configDir)
    const sessionsDir = join(configDir, 'sessions')
    if (isSameOrInside(target, sessionsDir) && target !== sessionsDir) return
    throw new ProjectPathDeletionError(
      `拒绝删除项目路径: ${target}（属于项目工作区 ${project.slug}，rootPath=${project.rootPath}）`,
    )
  }
}

/**
 * 文件浏览器删除 / 改名 / 移动的窄护栏。
 *
 * 允许：项目内的普通文件与子目录。
 * 拒绝：
 * - 项目根本身（等于删除 / 搬走整个项目绑定）；
 * - 项目根的祖先（同上，且会连带删掉同级内容）；
 * - 整个 `<rootPath>/.profer`（需要独立的「删除项目配置」操作，不能混在文件删除里）。
 */
export function assertProjectFileDeletionAllowed(targetPath: string, workspace: ProjectWorkspaceRef): void {
  if (workspace.storageMode !== 'project' || !workspace.rootPath) {
    throw new ProjectPathDeletionError(`非项目工作区不走此守卫: ${workspace.slug}`)
  }

  const target = canonicalizeWorkspaceRootPath(targetPath)
  const root = canonicalizeWorkspaceRootPath(workspace.rootPath)
  const configDir = canonicalizeWorkspaceRootPath(resolveWorkspaceLocation(workspace.slug).configDir)

  if (target === root) {
    throw new ProjectPathDeletionError(`禁止删除项目根目录: ${root}`)
  }
  // root 在 target 之内 → target 是项目根的祖先目录
  if (isSameOrInside(root, target)) {
    throw new ProjectPathDeletionError(`禁止删除项目根的上级目录: ${target}（项目根 ${root}）`)
  }
  if (target === configDir) {
    throw new ProjectPathDeletionError(`禁止整体删除项目配置目录: ${configDir}（需走独立的「删除项目配置」操作）`)
  }
}
