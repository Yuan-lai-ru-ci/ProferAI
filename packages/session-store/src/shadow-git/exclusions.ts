/**
 * Shadow Git 的采集排除规则。
 *
 * 排除的目标不是「省字节」，而是**保住回退语义的可信度**：
 * - 进入 `.git` 会读到数十万松散对象，进入 `node_modules` 会把体积放大几百倍，
 *   两者都只消耗上限预算，对「恢复用户文件」没有任何贡献；
 * - 产物目录（dist/build/out/...）每轮都在变，捕获它们会让每次快照都产生巨大 diff，
 *   却永远无法用它们还原出有意义的源码状态。
 *
 * 取向很明确：**只排除「用户不会想回退的生成物」，绝不排除用户源码目录**。
 * 少捕获的代价是回退不完整（可感知、可解释），误排源码目录的代价是用户以为有快照
 * 却在回退时发现文件没被记录（不可感知）。因此 src/vendor/docs 这类目录永不排除。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 永不进入的目录：版本库自身、依赖树、Profer/Agent 私有目录、构建与缓存产物。
 *
 * 名字按小写存储，比较时统一小写——macOS 默认大小写不敏感、Windows 也不敏感，
 * 若按字面比较，`Node_Modules` 就会绕过排除。
 */
export const SHADOW_NEVER_ENTER_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.profer',
  '.profer-pi-checkpoints',
  '.claude',
  '.claude-plugin',
  '.migration-backup',
  '.context',
  '.runtime',
  'shadow.git',
  'viz-fragments',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
  '.venv',
  '__pycache__',
])

/**
 * 纯系统噪音文件：内容对回退没有价值，且常被外部进程占用导致读取失败。
 *
 * 注意 `.DS_Store` 是文件不是目录，不能放进上面的目录集合——放错会产生「同名目录被排除」
 * 的误伤，而它本身只是 Finder 的视图缓存。
 */
export const SHADOW_SKIP_FILE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
])

/** 上述集合的小写镜像：导出值保持字面形态便于阅读，匹配必须走大小写不敏感的比较。 */
const SHADOW_SKIP_FILE_NAMES_LOWER: ReadonlySet<string> = new Set(
  [...SHADOW_SKIP_FILE_NAMES].map((name) => name.toLowerCase()),
)

/**
 * 用户可见的依赖声明：虽然以 `.lock` 结尾，但它们是源码的一部分。
 *
 * 锁文件排除的初衷是躲开 Electron/Chromium 的 `SingletonLock`、`LOCK` 这类运行时锁，
 * 那些文件对回退无意义；而 `package-lock.json`/`bun.lock`/`yarn.lock` 记录了依赖决策，
 * 丢了就等于回退出一个无法复现的环境，所以必须保留。
 */
const SHADOW_DEPENDENCY_MANIFEST_FILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'bun.lock',
  'yarn.lock',
  'pnpm-lock.yaml',
])

/** 运行时锁文件的形状：以 `.lock` 结尾（`LOCK`、`SingletonLock` 不带扩展名，另行匹配）。 */
const RUNTIME_LOCK_SUFFIX = /\.lock$/i
const RUNTIME_LOCK_NAMES: ReadonlySet<string> = new Set([
  'lock',
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
])

export function shouldSkipShadowDirectory(name: string): boolean {
  if (!name) return false
  return SHADOW_NEVER_ENTER_DIRS.has(name.toLowerCase())
}

export function shouldSkipShadowFile(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  if (SHADOW_SKIP_FILE_NAMES_LOWER.has(lower)) return true
  if (SHADOW_DEPENDENCY_MANIFEST_FILES.has(lower)) return false
  if (RUNTIME_LOCK_NAMES.has(lower)) return true
  return RUNTIME_LOCK_SUFFIX.test(lower)
}

/** 路径比较用的规范形：resolve 消除 `.`/`..`/尾斜杠，Windows 再统一大小写。 */
function comparablePath(value: string): string {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * candidate 是否位于 parent 之内（相等也算在内）。
 *
 * 必须用 `relative` 而不是字符串前缀：`/a/bc` 以 `/a/b` 开头，但并不是它的子路径；
 * 字符串前缀判定会把用户的兄弟目录整片排除掉，而且这种错误极难在测试之外被发现。
 */
export function isWithinPath(parent: string, candidate: string): boolean {
  if (!parent || !candidate) return false
  const parentPath = comparablePath(parent)
  const candidatePath = comparablePath(candidate)
  if (parentPath === candidatePath) return true
  const diff = relative(parentPath, candidatePath)
  // 跨盘符时 `relative` 返回绝对路径，此时不能当子路径。
  if (!diff || isAbsolute(diff)) return false
  if (diff === '..' || diff.startsWith(`..${sep}`)) return false
  return true
}

/**
 * candidate 是否落在任一排除路径内。
 *
 * 相对路径的排除项直接忽略：采集器只处理绝对路径，相对项的基准（cwd）在 Electron 主进程里
 * 不可靠，按它解释等于随机排除；宁可当作「这条规则无效」，也不要排除错东西。
 */
export function isExcludedAbsolutePath(candidate: string, excludes: readonly string[]): boolean {
  if (!candidate) return false
  for (const exclude of excludes) {
    if (!exclude || !isAbsolute(exclude)) continue
    if (isWithinPath(exclude, candidate)) return true
  }
  return false
}
