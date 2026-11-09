/**
 * Shadow Git 的根命名空间：`rootId` + `relativePath` 的合法性与合成/解析。
 *
 * 为什么需要这一层：一个工作区可能挂多个根（主根 + attached 目录），它们最终要落进
 * **同一个** git tree。tree 里只有路径字符串，没有「哪个根」的概念，所以
 * `roots/<rootId>/<relativePath>` 既是命名空间又是唯一索引：任意时刻都能从 tree 路径
 * 反推出「哪个根、根下哪个文件」，回退时才能把字节写回正确的物理位置。
 *
 * 这一层全部是纯函数且不 throw：越界输入只会被拒绝（返回 false / null / ''），
 * 让上层在枚举阶段就把坏数据过滤掉，而不是在写 tree 时半途失败。
 */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import type { ShadowRoot } from './types'

/** tree 中承载所有根的顶层目录名。 */
export const SHADOW_ROOTS_PREFIX = 'roots'

/**
 * rootId 形状：字母数字开头，随后允许 `.` `_` `-`，总长 1~80。
 *
 * 首字符限制为字母数字，是为了让 `.`/`..` 天然不合法——rootId 会成为一个真实目录名，
 * 一旦允许点段，`roots/../..` 就能把 tree 路径逃出 `roots/` 前缀。
 */
const ROOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Windows 盘符前缀；posix 上 `isAbsolute` 认不出来，必须单独拦。 */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/

/** git tree 路径的 sha256 摘要取前 16 位十六进制。 */
const ATTACHED_ID_DIGEST_LENGTH = 16

export function isSafeShadowRootId(value: string): boolean {
  if (!value) return false
  // 正则已经排除以 `.` 开头，这里显式写明两道最危险的相对段，避免日后改正则时失守。
  if (value === '.' || value === '..') return false
  return ROOT_ID_PATTERN.test(value)
}

/**
 * relativePath 合法性：允许 `/` 与 `\` 混用（调用方可能来自 Windows 或用户粘贴），
 * 但拒绝绝对路径、盘符、NUL 以及任何空段/`.`/`..` 段。
 *
 * 空段也要拒：`a//b` 与 `a/b` 在 git 里是同一个路径，放行会让「一个文件两种写法」
 * 在 diff 里变成一次假的删除+新增。
 */
export function isSafeShadowRelativePath(value: string): boolean {
  if (!value) return false
  if (value.includes('\0')) return false
  // 前导 `/` 是 posix 绝对路径，前导 `\` 是 UNC/Windows 绝对路径。
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (WINDOWS_DRIVE_PATTERN.test(value)) return false
  const segments = value.split(/[\\/]/)
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
  }
  return true
}

/**
 * 把任意分隔符写法归一为 git 风格正斜杠路径。
 *
 * 只做形式归一（分隔符、重复斜杠、`.` 段），**不**折叠 `..`：
 * 语义上的越界必须由 `isSafeShadowRelativePath` 判定并拒绝，静默折叠等于偷偷改写用户意图。
 */
export function toGitRelativePath(value: string): string {
  if (!value) return ''
  return value
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

/** `toGitRelativePath` 的逆操作：git 路径 → 当前平台原生路径。 */
export function fromGitRelativePath(value: string): string {
  const normalized = toGitRelativePath(value)
  if (!normalized) return ''
  return normalized.split('/').join(sep)
}

/**
 * 合成 tree 路径。
 *
 * 不在这里做合法性校验：调用链路（walk → tree-builder）已保证 rootId/relativePath 合法，
 * 重复校验只会让「非法输入」得到一串静默的空字符串，掩盖上游的问题。
 */
export function shadowTreePath(rootId: string, relativePath: string): string {
  const normalized = toGitRelativePath(relativePath)
  if (!normalized) return `${SHADOW_ROOTS_PREFIX}/${rootId}`
  return `${SHADOW_ROOTS_PREFIX}/${rootId}/${normalized}`
}

/**
 * 解析 tree 路径；任何不合法输入返回 null（而不是 throw）。
 *
 * 只接受**文件级**路径：`roots/<rootId>` 这种子树根没有 relativePath，
 * 上层需要子树时应当直接拼 `shadowTreePath(rootId, '')`，不要指望从解析结果反推。
 */
export function parseShadowTreePath(value: string): { rootId: string; relativePath: string } | null {
  if (!value || value.includes('\0')) return null
  const segments = value.split('/')
  const [prefix, rootId, ...rest] = segments
  if (prefix !== SHADOW_ROOTS_PREFIX) return null
  if (!rootId || !isSafeShadowRootId(rootId)) return null
  const relativePath = rest.join('/')
  if (!isSafeShadowRelativePath(relativePath)) return null
  return { rootId, relativePath }
}

/**
 * 由附加目录的绝对路径派生稳定 rootId。
 *
 * 用路径哈希而不是路径字面量：rootId 要进 git tree 路径，含空格、冒号、盘符的原始路径
 * 会污染 tree 且在不同平台表现不一致；哈希把任意路径压成固定形状的目录名。
 * 先 `resolve` 再哈希，保证 `./a`、`a`、`x/../a` 这类写法落到同一个 id——
 * rootId 一旦抖动，同一目录的历史快照就会分裂成两条互不相认的链。
 */
export function deriveAttachedRootId(rootPath: string): string {
  const resolved = resolve(rootPath)
  // Windows 文件系统大小写不敏感：不统一小写会让同一目录派生出两个 id。
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex')
  return `attached-${digest.slice(0, ATTACHED_ID_DIGEST_LENGTH)}`
}

/** 去重用的路径身份：resolve 消除 `.`/`..`/尾斜杠，Windows 再统一大小写。 */
function pathIdentity(pathValue: string): string {
  const resolved = resolve(pathValue)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 过滤并去重根列表，保持入参顺序（先到先得）。
 *
 * 去重必须同时看 id 和物理路径：id 重复会让两个根互相覆盖对方的 tree 子树，
 * 路径重复会让同一个文件被枚举两次并在 tree 里出现两条祖先链。两者都是不可恢复的错乱，
 * 所以宁可丢根也不能放行。这里只做纯过滤，不 throw——调用方拿到的是「能用的根」，
 * 缺了哪个根由上层决定要不要提示用户。
 */
export function normalizeShadowRoots(roots: ShadowRoot[]): ShadowRoot[] {
  const accepted: ShadowRoot[] = []
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  for (const root of roots) {
    if (!root) continue
    if (!isSafeShadowRootId(root.rootId)) continue
    if (typeof root.rootPath !== 'string' || !isAbsolute(root.rootPath)) continue
    const identity = pathIdentity(root.rootPath)
    if (seenIds.has(root.rootId) || seenPaths.has(identity)) continue
    seenIds.add(root.rootId)
    seenPaths.add(identity)
    accepted.push(root)
  }
  return accepted
}
