/**
 * 项目内会话路径的唯一构造/校验入口。
 *
 * 项目文件夹可能来自另一台机器、也可能被手工编辑过：`index.json` / `session.json`
 * 里的会话 ID 属于**不可信输入**。会话 ID 会被直接拼进
 * `<root>/.profer/sessions/<id>/`，所以这里集中做三件事：
 *
 * 1. 按会话 ID 生成规则（`randomUUID()` → 字母数字与 `-`）校验 ID；
 * 2. 构造后按解析后的绝对路径确认目标仍在 `.profer/sessions` 内；
 * 3. 检查目标目录及其在项目内的祖先不是指向项目外的符号链接。
 *
 * 刻意不提供「修正 ID」的能力：非法条目一律拒绝并交给调用方诊断，
 * 重写 ID 会悄悄切断父子会话、fork、自动化等既有引用。
 */

import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 项目配置目录名（与 workspace-locator 保持一致）。 */
export const PROJECT_CONFIG_DIR_NAME = '.profer'
/** 项目内会话目录名。 */
export const PROJECT_SESSIONS_DIR_NAME = 'sessions'
/** 每个会话目录内的自描述元数据文件名。 */
export const PROJECT_SESSION_META_FILE_NAME = 'session.json'
/** 会话 ID 长度上限：UUID 为 36，留出历史/外部 ID 的余量。 */
const MAX_SESSION_ID_LENGTH = 128
/**
 * 会话 ID 白名单：首字符必须是字母或数字，其余允许字母数字、`.`、`_`、`-`。
 *
 * 这覆盖了 `randomUUID()` 的全部产出，同时排除路径分隔符、`..`、绝对路径、
 * 空白与控制字符；不允许首字符是 `.` 也顺手挡掉了 `.` / `..` / 隐藏目录。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type ProjectSessionPathErrorCode =
  | 'invalid-session-id'
  | 'path-escape'
  | 'symlink-escape'

/** 项目会话路径不可用（ID 非法 / 越界 / 符号链接逃逸）。 */
export class ProjectSessionPathError extends Error {
  constructor(
    public readonly code: ProjectSessionPathErrorCode,
    public readonly sessionId: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectSessionPathError'
  }
}

/** 会话 ID 是否可用于拼项目会话路径。 */
export function isValidProjectSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) return false
  if (!SESSION_ID_PATTERN.test(value)) return false
  // Windows 会静默去掉结尾的点，`abc.` 与 `abc` 会撞目录。
  if (value.endsWith('.')) return false
  return true
}

/** 断言会话 ID 合法；非法时抛出带原始值的可诊断错误（绝不修正 ID）。 */
export function assertValidProjectSessionId(value: unknown): string {
  if (!isValidProjectSessionId(value)) {
    throw new ProjectSessionPathError(
      'invalid-session-id',
      typeof value === 'string' ? value : String(value),
      `非法的项目会话 ID: ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** 项目会话根目录：`<root>/.profer/sessions`。 */
export function projectSessionsDir(rootPath: string): string {
  return join(rootPath, PROJECT_CONFIG_DIR_NAME, PROJECT_SESSIONS_DIR_NAME)
}

function isStrictlyInside(parentDir: string, candidate: string): boolean {
  const rel = relative(resolve(parentDir), resolve(candidate))
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 检查 rootPath → target 之间每一级已存在的组件：符号链接解析后必须仍在项目根内。
 *
 * 项目根本身可以是符号链接（用户常见布局，locator 也会 realpath 归一化），
 * 只拦「指向项目根之外」的那一跳。
 */
function assertNoEscapingSymlink(rootPath: string, target: string): void {
  let rootReal: string
  try {
    rootReal = realpathSync(rootPath)
  } catch {
    // 项目根不存在：交给调用方（迁移会显式报告），这里不做额外判断。
    return
  }
  const relPath = relative(resolve(rootPath), resolve(target))
  if (!relPath) return
  let current = resolve(rootPath)
  for (const segment of relPath.split(sep)) {
    if (!segment) continue
    current = join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      // 后续层级还不存在（首次写入），无需继续。
      return
    }
    if (!stat.isSymbolicLink()) continue
    let resolved: string
    try {
      resolved = realpathSync(current)
    } catch {
      throw new ProjectSessionPathError('symlink-escape', '', `项目会话路径的符号链接无法解析: ${current}`)
    }
    const insideRoot = !relative(rootReal, resolved).startsWith('..') && !isAbsolute(relative(rootReal, resolved))
    if (!insideRoot) {
      throw new ProjectSessionPathError(
        'symlink-escape',
        '',
        `项目会话路径的符号链接指向项目外: ${current} -> ${resolved}`,
      )
    }
  }
}

/** 校验项目内任意文件目标没有越界或经符号链接逃逸。 */
export function assertProjectPathSafe(rootPath: string, target: string): void {
  const root = resolve(rootPath)
  const candidate = resolve(target)
  if (!isStrictlyInside(root, candidate)) {
    throw new ProjectSessionPathError('path-escape', '', `项目路径越界: ${candidate}`)
  }
  assertNoEscapingSymlink(rootPath, candidate)
}

/**
 * 解析并校验会话数据目录 `<root>/.profer/sessions/<id>`。
 *
 * 非法 ID、路径越界、符号链接逃逸都会抛 `ProjectSessionPathError`。
 * 调用方必须显式处理：导入路径应拒绝该条目，写入路径应放弃写入。
 */
export function resolveProjectSessionDir(rootPath: string, sessionId: unknown): string {
  const id = assertValidProjectSessionId(sessionId)
  const sessionsDir = projectSessionsDir(rootPath)
  const target = resolve(sessionsDir, id)
  if (!isStrictlyInside(sessionsDir, target)) {
    throw new ProjectSessionPathError('path-escape', id, `项目会话路径越界: ${target}`)
  }
  assertNoEscapingSymlink(rootPath, target)
  return target
}

/** `resolveProjectSessionDir` 的不抛错版本；用于「扫到就跳过」的读取路径。 */
export function tryResolveProjectSessionDir(rootPath: string, sessionId: unknown): string | undefined {
  try {
    return resolveProjectSessionDir(rootPath, sessionId)
  } catch {
    return undefined
  }
}

/**
 * 校验 `<root>/.profer/sessions` 自身仍在项目内（用于整目录扫描前的边界检查）。
 *
 * 返回 `false` 表示该项目的会话根不可信，调用方应跳过整个项目而不是逐条尝试。
 */
export function isProjectSessionsDirSafe(rootPath: string): boolean {
  try {
    assertNoEscapingSymlink(rootPath, projectSessionsDir(rootPath))
    return true
  } catch {
    return false
  }
}
