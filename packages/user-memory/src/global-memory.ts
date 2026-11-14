/**
 * 全局用户记忆（跨工作区共享的画像与主题记忆）。
 *
 * 存储：`<configDir>/global-memory/`，纯 Markdown 目录树。
 * 这个模块是唯一的事实来源：Electron 主进程和 profer CLI 都通过它读写，
 * 不再各自实现一份路径与安全校验。
 *
 * 安全约束（与旧实现一致，不能放宽）：
 * - 只允许访问记忆根目录内的 `.md` 文件
 * - 拒绝 `..` 穿越、绝对路径、反斜杠、符号链接
 * - 单文件上限 10 MB
 * - 索引 `MEMORY.md` 不可删除
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { GlobalMemorySummary, SkillFileContent, SkillFileNode } from '@profer/shared'
import { getGlobalMemoryDir } from './paths'
import { withFileLock } from './lock'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const INDEX_FILE = 'MEMORY.md'
const INITIALIZED_MARKER = '.initialized'
const WRITE_LOCK_FILE = '.write.lock'

/** 全局记忆索引文件名（`MEMORY.md`）。 */
export const GLOBAL_MEMORY_INDEX_FILE = INDEX_FILE

/** 首次初始化写入的骨架文件。 */
export const INITIAL_GLOBAL_MEMORY_FILES: Record<string, string> = {
  'MEMORY.md': '# 全局记忆索引\n\n- 用户明确提供或确认的背景 → `user-profile.md`\n- 本地感知扫描的推断结论 → `user-sense.md`\n- 稳定偏好与协作方式 → `preferences.md`\n- 服务器与基础设施 → `infrastructure/servers.md`\n- 设备信息 → `devices/README.md`\n',
  'user-profile.md': '# 用户背景\n\n<!-- 用户明确提供或确认的信息。 -->\n',
  'user-sense.md': '# 用户感知结论\n\n<!-- 本地扫描推断；记录来源、置信度和最近核对日期。 -->\n',
  'preferences.md': '# 稳定偏好\n\n<!-- 用户明确表达或确认的跨工作区偏好。 -->\n',
  'infrastructure/servers.md': '# 服务器\n\n<!-- 用户可见目录：格式 `- [唯一ID] 名称`；标记区外写 Agent 需要的详情。 -->\n<!-- profer:visible-list:start -->\n<!-- profer:visible-list:end -->\n',
  'devices/README.md': '# 设备\n\n<!-- 用户可见目录：格式 `- [唯一ID]|类型 名称`；类型为 computer/phone/watch/tablet/other。标记区外写 Agent 需要的详情。 -->\n<!-- profer:visible-list:start -->\n<!-- profer:visible-list:end -->\n',
}

/** 记忆根目录绝对路径（不创建目录）。 */
export function getGlobalMemoryRoot(configDir: string): string {
  return getGlobalMemoryDir(configDir)
}

/**
 * 确保记忆目录已初始化，返回根目录。
 *
 * 幂等：只在首次（缺少 `.initialized` 标记）时写骨架文件，
 * 之后即使骨架文件被用户删除也不会重建，避免把用户的删除操作撤销掉。
 */
export function ensureGlobalMemoryInitialized(configDir: string): string {
  const root = getGlobalMemoryDir(configDir)
  const firstInitialization = !existsSync(join(root, INITIALIZED_MARKER))
  mkdirSync(root, { recursive: true, mode: 0o700 })

  if (firstInitialization) {
    for (const [name, content] of Object.entries(INITIAL_GLOBAL_MEMORY_FILES)) {
      const file = join(root, name)
      if (!existsSync(file)) {
        mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 })
        writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      }
    }
    try { writeFileSync(join(root, INITIALIZED_MARKER), '', { encoding: 'utf8', mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }

  return root
}

function resolveMemoryPath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\\') || relativePath.startsWith('/')) {
    throw new Error('全局记忆路径无效')
  }
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || extname(target).toLowerCase() !== '.md') {
    throw new Error('只允许访问全局记忆目录内的 Markdown 文件')
  }
  try {
    const targetStat = lstatSync(target)
    if (targetStat.isSymbolicLink()) throw new Error('不允许访问符号链接')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existsSync(target)) {
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(target)
    const realRel = relative(realRoot, realTarget)
    if (realRel.startsWith(`..${sep}`) || realRel === '..' || realRel === '') throw new Error('全局记忆路径越界')
  }
  return target
}

function buildTree(root: string, current: string, depth = 0): SkillFileNode[] {
  if (depth > 8) return []
  let entries
  try { entries = readdirSync(current, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || (entry.isFile() && extname(entry.name).toLowerCase() === '.md')))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const absolute = join(current, entry.name)
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (entry.isDirectory()) return { relativePath, name: entry.name, type: 'directory' as const, children: buildTree(root, absolute, depth + 1) }
      const stat = statSync(absolute)
      return { relativePath, name: entry.name, type: 'file' as const, size: stat.size, isText: true }
    })
}

/** 记忆文件树（目录优先 + 名称排序）。 */
export function listGlobalMemoryFiles(configDir: string): SkillFileNode[] {
  const root = ensureGlobalMemoryInitialized(configDir)
  return buildTree(root, root)
}

/** 摘要：索引是否存在、文件数、总大小、最近更新时间。 */
export function getGlobalMemorySummary(configDir: string): GlobalMemorySummary {
  const root = ensureGlobalMemoryInitialized(configDir)
  const files = listGlobalMemoryFiles(configDir)
  const all: SkillFileNode[] = []
  const collect = (nodes: SkillFileNode[]) => nodes.forEach((node) => node.type === 'file' ? all.push(node) : collect(node.children ?? []))
  collect(files)
  const index = all.find((file) => file.relativePath === INDEX_FILE)
  return {
    indexExists: Boolean(index),
    fileCount: all.length,
    totalSize: all.reduce((sum, file) => sum + (file.size ?? 0), 0),
    updatedAt: Math.max(0, ...all.map((file) => statSync(resolveMemoryPath(root, file.relativePath)).mtimeMs)),
  }
}

/** 读取单个记忆文件。 */
export function readGlobalMemoryFile(configDir: string, relativePath: string): SkillFileContent {
  const root = ensureGlobalMemoryInitialized(configDir)
  const file = resolveMemoryPath(root, relativePath)
  if (!existsSync(file)) throw new Error(`全局记忆文件不存在: ${relativePath}`)
  const stat = statSync(file)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('全局记忆文件无效或超过 10 MB')
  return { relativePath, content: readFileSync(file, 'utf8'), isText: true, size: stat.size }
}

/**
 * 写入单个记忆文件（带跨进程写锁）。
 *
 * 锁只在写入期间持有；读取不加锁，见 lock.ts 的说明。
 */
export function writeGlobalMemoryFile(configDir: string, relativePath: string, content: string): void {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('全局记忆内容无效或超过 10 MB')
  const root = ensureGlobalMemoryInitialized(configDir)
  const file = resolveMemoryPath(root, relativePath)
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 })

  withFileLock(join(root, WRITE_LOCK_FILE), () => {
    // 二次解析目录真实路径，拒绝经符号链接逃离全局记忆根目录。
    const realRoot = realpathSync(root)
    const realParent = realpathSync(resolve(file, '..'))
    const parentRel = relative(realRoot, realParent)
    if (parentRel.startsWith(`..${sep}`) || parentRel === '..') throw new Error('全局记忆路径越界')
    writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
  })
}

/** 在写锁内读取、去重并追加；不允许通过此入口改动索引。 */
export function appendGlobalMemoryFile(configDir: string, relativePath: string, entry: string): { added: boolean } {
  if (relativePath === INDEX_FILE) throw new Error('追加入口不能修改全局记忆索引')
  if (typeof entry !== 'string' || !entry.trim() || entry.length > 6000) throw new Error('全局记忆条目无效')
  const root = ensureGlobalMemoryInitialized(configDir)
  const file = resolveMemoryPath(root, relativePath)
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 })
  return withFileLock(join(root, WRITE_LOCK_FILE), () => {
    const realRoot = realpathSync(root)
    const realParent = realpathSync(resolve(file, '..'))
    const parentRel = relative(realRoot, realParent)
    if (parentRel.startsWith(`..${sep}`) || parentRel === '..') throw new Error('全局记忆路径越界')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (Buffer.byteLength(current, 'utf8') > MAX_FILE_BYTES) throw new Error('全局记忆内容超过 10 MB')
    const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    const target = normalize(entry)
    if (normalize(current).includes(target)) return { added: false }
    const separator = current && !current.endsWith('\n') ? '\n' : ''
    const next = `${current}${separator}\n${entry.trim()}\n`
    if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) throw new Error('全局记忆内容超过 10 MB')
    writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 })
    return { added: true }
  })
}

/** 删除单个记忆文件；索引文件不可删除。 */

export function deleteGlobalMemoryFile(configDir: string, relativePath: string): void {
  if (relativePath === INDEX_FILE) throw new Error('不能删除全局记忆索引')
  const root = ensureGlobalMemoryInitialized(configDir)
  const file = resolveMemoryPath(root, relativePath)
  if (!existsSync(file)) return
  if (!statSync(file).isFile()) throw new Error('只能删除记忆文件')

  withFileLock(join(root, WRITE_LOCK_FILE), () => { rmSync(file) })
}

/** 关键词搜索：每个文件只返回首个命中片段。 */
export function searchGlobalMemory(
  configDir: string,
  query: string,
  topK = 10,
): Array<{ relativePath: string; content: string; startIndex: number; endIndex: number }> {
  const normalized = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!normalized) return []
  const root = ensureGlobalMemoryInitialized(configDir)
  const hits: Array<{ relativePath: string; content: string; startIndex: number; endIndex: number }> = []

  const walk = (nodes: SkillFileNode[]) => {
    for (const node of nodes) {
      if (node.type === 'directory') { walk(node.children ?? []); continue }
      if ((node.size ?? 0) > MAX_FILE_BYTES) continue
      const text = readFileSync(resolveMemoryPath(root, node.relativePath), 'utf8')
      const index = text.toLowerCase().indexOf(normalized)
      if (index >= 0) {
        const startIndex = Math.max(0, index - 300)
        const endIndex = Math.min(text.length, index + normalized.length + 700)
        hits.push({ relativePath: node.relativePath, content: text.slice(startIndex, endIndex), startIndex, endIndex })
      }
    }
  }

  walk(listGlobalMemoryFiles(configDir))
  return hits.slice(0, Math.max(1, Math.min(20, Math.floor(topK) || 10)))
}
