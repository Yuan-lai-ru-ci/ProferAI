/**
 * WebUI `@` 文件引用候选。
 *
 * 只扫描会话已授权的根（`RemoteFileRoots.sessionRoot`），返回的 path 是**相对该根**
 * 的 POSIX 风格路径 —— 与桌面端 `@file:<path>` 的相对路径基准一致，
 * 同时不把机器绝对路径暴露给浏览器。
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface WorkspaceFileOption {
  /** 相对会话 cwd 的 POSIX 路径：会话文件直接是相对名，工作区文件带 `../workspace-files/` 前缀 */
  path: string
  name: string
  type: 'file' | 'dir'
  /** 来源分组：与桌面端 @ 候选的「会话文件 / 工作区文件」两组对应 */
  source: 'session' | 'workspace'
}

/** 分组候选（桌面端 FileMentionList 的两组） */
export interface MentionFileGroups {
  session: WorkspaceFileOption[]
  workspace: WorkspaceFileOption[]
}

/** 这些目录无论多深都不进候选：体积大且极少是引用目标 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '__pycache__',
  '.cache', '.venv', 'venv', 'target', 'vendor', '.next',
])
/**
 * 允许出现在候选里的隐藏目录，与桌面端 file-search-service 的
 * SEARCHABLE_HIDDEN_DIRECTORIES 同源：.claude / .context 是 Agent 的工作上下文，
 * 用户会引用里面的 CLAUDE.md、plan、goal 等。其余点开头目录仍跳过。
 */
const SEARCHABLE_HIDDEN_DIRECTORIES = new Set(['.claude', '.context'])

/** 扫描预算：防止超大项目把移动端请求拖死 */
const MAX_SCAN_ENTRIES = 4_000
const MAX_RESULTS = 200

/**
 * 广度优先扫描一个根，`pathBase` 决定返回路径相对谁（会话 cwd = sessionRoot）。
 * `query` 同时匹配文件名和相对路径（不区分大小写），空查询返回最浅的一批。
 */
function scanRoot(
  root: string,
  pathBase: string,
  source: 'session' | 'workspace',
  query: string,
  limit: number,
): WorkspaceFileOption[] {
  const results: WorkspaceFileOption[] = []
  const queue: string[] = [root]
  const q = query.trim().toLowerCase()
  let scanned = 0

  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES && results.length < limit) {
    const dir = queue.shift()
    if (!dir) break
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 子目录无权读取：跳过，不影响其它分支
      continue
    }
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_ENTRIES || results.length >= limit) break
      // 隐藏项默认不引用；.claude / .context 与桌面端一致，允许作为目录候选
      if (entry.name.startsWith('.') && !SEARCHABLE_HIDDEN_DIRECTORIES.has(entry.name)) continue
      const full = join(dir, entry.name)
      const isDirectory = entry.isDirectory()
      if (isDirectory && SKIP_DIRS.has(entry.name)) continue
      scanned += 1
      // 统一相对 sessionRoot（= 会话 cwd），工作区文件因此带 ../workspace-files/ 前缀，
      // 模型按 cwd 就能读到；同时不向浏览器暴露机器绝对路径
      const rel = relative(pathBase, full).split(sep).join('/')
      if (!q || rel.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)) {
        results.push({ path: rel, name: entry.name, type: isDirectory ? 'dir' : 'file', source })
      }
      if (isDirectory) queue.push(full)
    }
  }
  return results
}

/**
 * 列出两组候选：会话文件（会话私有根）+ 工作区文件（整个工作区共享）。
 * 与桌面端 FileMentionList 的两个分组一一对应。
 */
export function listMentionFileGroups(
  sessionRoot: string,
  workspaceFilesDir: string,
  query: string,
  limit = MAX_RESULTS,
): MentionFileGroups {
  return {
    session: scanRoot(sessionRoot, sessionRoot, 'session', query, limit),
    workspace: scanRoot(workspaceFilesDir, sessionRoot, 'workspace', query, limit),
  }
}

/** 兼容旧调用：只取会话文件组 */
export function listWorkspaceFilesForMention(
  sessionRoot: string,
  query: string,
  limit = MAX_RESULTS,
): WorkspaceFileOption[] {
  return scanRoot(sessionRoot, sessionRoot, 'session', query, limit)
}
