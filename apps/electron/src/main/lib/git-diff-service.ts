/**
 * Git Diff 服务
 *
 * 提供工作区文件变更检测、diff 获取、文件还原等 Git 操作。
 * 复用 git-detector.ts 中 runGitCommand 的 spawnSync 模式。
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { ChangedFileEntry, UnstagedChangesResult } from '@proma/shared'
import type { ChangeSource, ChangedFileStatus } from '@proma/shared'

/** 大文件读取上限：超过则跳过，避免 IPC 序列化撑爆内存 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

/**
 * 校验 filePath（相对路径）解析后是否仍位于 root 目录内。
 * 拒绝绝对路径以及 `..` 穿越。
 */
function isPathSafe(root: string, filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  if (isAbsolute(filePath)) return false
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, filePath)
  const rootWithSep = resolvedRoot.endsWith('/') ? resolvedRoot : resolvedRoot + '/'
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep)
}

/**
 * 执行 Git 命令
 *
 * @param args - Git 命令参数
 * @param cwd - 工作目录
 * @returns 命令输出，如果失败返回 null
 */
function runGitCommand(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    })

    if (result.error) {
      console.error('[git-diff-service] git 命令错误:', result.error)
      return null
    }
    if (result.status === 0) {
      return result.stdout.trim()
    }
  } catch {
    // 命令执行失败
  }

  return null
}

/**
 * 计算文件的来源标识
 *
 * filePath 是相对于 gitRoot 的路径，需要拼成绝对路径后再和 session/workspace 路径比较
 */
function computeSource(
  filePath: string,
  gitRoot: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
): ChangeSource {
  const absolutePath = join(gitRoot, filePath)
  let inSession = false
  let inWorkspace = false

  if (sessionPath) {
    const normalized = sessionPath.endsWith('/') ? sessionPath : sessionPath + '/'
    if (absolutePath.startsWith(normalized)) {
      inSession = true
    }
  }

  if (workspaceFilesPath) {
    const normalized = workspaceFilesPath.endsWith('/') ? workspaceFilesPath : workspaceFilesPath + '/'
    if (absolutePath.startsWith(normalized)) {
      inWorkspace = true
    }
  }

  if (inSession && inWorkspace) return 'both'
  if (inSession) return 'session'
  if (inWorkspace) return 'workspace'
  return 'none'
}

/**
 * 解析 numstat 输出为 path -> { additions, deletions } 映射。
 * 对 rename/copy 行（格式 `add\tdel\told => new` 或带 `{...}` 的），以新路径为 key。
 */
function parseNumstat(numStat: string | null): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  if (!numStat) return map
  for (const line of numStat.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parseInt(parts[0]!, 10)
    const deletions = parseInt(parts[1]!, 10)
    let path = parts.slice(2).join('\t')
    // 处理 rename 格式 `old => new`
    const arrowIdx = path.indexOf(' => ')
    if (arrowIdx >= 0) {
      path = path.slice(arrowIdx + 4)
    }
    map.set(path, {
      additions: isNaN(additions) ? 0 : additions,
      deletions: isNaN(deletions) ? 0 : deletions,
    })
  }
  return map
}

/**
 * 获取未暂存的文件变更列表（支持多 Git 仓库）
 */
export async function getUnstagedChanges(
  dirPath: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
  extraPaths?: string[],
): Promise<UnstagedChangesResult> {
  // 收集所有候选目录中的不重复 Git 仓库根
  const candidates = [dirPath, sessionPath, workspaceFilesPath, ...(extraPaths || [])].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  const gitRoots: string[] = []
  for (const cand of candidates) {
    for (const root of findAllGitRoots(cand)) {
      if (!gitRoots.includes(root)) gitRoots.push(root)
    }
  }

  if (gitRoots.length === 0) {
    return { isGitRepo: false, files: [], untrackedFiles: [], gitRootNames: [] }
  }

  const allFiles: ChangedFileEntry[] = []
  const allUntracked: string[] = []

  for (const gitRoot of gitRoots) {
    // 获取变更文件列表 (M=modified, D=deleted, A=added, R=renamed, C=copied, T=type)
    const nameStatus = runGitCommand(['diff', '--name-status'], gitRoot)
    const numStat = runGitCommand(['diff', '--numstat'], gitRoot)
    const numStatMap = parseNumstat(numStat)

    if (nameStatus) {
      const statusLines = nameStatus.split('\n').filter(Boolean)

      for (const statusLine of statusLines) {
        // 匹配 M/D/A/T 单字符状态（带可选目标路径）
        // 以及 R/C 带相似度评分（如 R100、C75），格式：`R100\told\tnew`
        const simpleMatch = statusLine.match(/^([MDAT])\t(.+)$/)
        const renameMatch = statusLine.match(/^([RC])\d*\t([^\t]+)\t(.+)$/)

        let status: ChangedFileStatus
        let filePath: string

        if (simpleMatch) {
          const code = simpleMatch[1]!
          status = code === 'D' ? 'deleted' : 'modified'
          filePath = simpleMatch[2]!
        } else if (renameMatch) {
          status = 'modified'
          filePath = renameMatch[3]! // 使用新路径
        } else {
          continue
        }

        const stats = numStatMap.get(filePath) ?? { additions: 0, deletions: 0 }

        allFiles.push({
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
          source: computeSource(filePath, gitRoot, sessionPath, workspaceFilesPath),
          gitRoot,
        })
      }
    }

    // 获取未追踪文件
    const untrackedOutput = runGitCommand(['ls-files', '--others', '--exclude-standard'], gitRoot)
    if (untrackedOutput) {
      // 保持相对路径，与 modified 文件一致；renderer 通过 dirPath/gitRoot 拼接绝对路径
      allUntracked.push(...untrackedOutput.split('\n').filter(Boolean))
    }
  }

  return {
    isGitRepo: true,
    files: allFiles,
    untrackedFiles: allUntracked,
    gitRootNames: gitRoots.map((r) => r.split('/').pop() || r),
  }
}

/** 向下递归搜索所有 .git 目录，返回所有找到的仓库根（不提前停止） */
function findAllGitRootsDown(dirPath: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return []

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return []
  }

  const found: string[] = []
  for (const name of entries) {
    if (name === '.git') {
      found.push(dirPath)
      continue
    }
    if (name.startsWith('.') || name === 'node_modules') continue

    const fullPath = join(dirPath, name)
    let st
    try { st = statSync(fullPath) } catch { continue }
    if (!st.isDirectory()) continue

    if (existsSync(join(fullPath, '.git'))) {
      found.push(fullPath)
      // 已确认是 git root，不再深入避免重复
      continue
    }
    found.push(...findAllGitRootsDown(fullPath, maxDepth - 1))
  }

  return found
}

/** 查找 Git 仓库根目录（支持向上搜索子目录内的 repos），返回所有找到的根 */
function findAllGitRoots(baseDir: string): string[] {
  if (!existsSync(baseDir)) return []

  // 1. 向上搜索：git rev-parse --show-toplevel
  const toplevel = runGitCommand(['rev-parse', '--show-toplevel'], baseDir)
  const roots: string[] = []
  if (toplevel && existsSync(toplevel) && !roots.includes(toplevel)) {
    roots.push(toplevel)
  }

  // 2. 向下搜索所有子 .git
  for (const r of findAllGitRootsDown(baseDir, 3)) {
    if (!roots.includes(r)) roots.push(r)
  }

  return roots
}

/** 查找 Git 仓库根目录，先向上后向下搜索，失败返回 null */
function findGitRoot(baseDir: string): string | null {
  if (!existsSync(baseDir)) return null

  // 1. 向上搜索（cwd 在 git 仓库内）
  const toplevel = runGitCommand(['rev-parse', '--show-toplevel'], baseDir)
  if (toplevel && existsSync(toplevel)) return toplevel

  // 2. 向下搜索（寻找子目录中的 .git）
  return findGitReposDown(baseDir, 3)
}

/** 向下递归搜索 .git 目录（最大深度 3），返回第一个找到的仓库根 */
function findGitReposDown(dirPath: string, maxDepth: number): string | null {
  if (maxDepth <= 0) return null

  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return null
  }

  for (const name of entries) {
    if (name === '.git') return dirPath
    if (name.startsWith('.') || name === 'node_modules') continue

    const fullPath = join(dirPath, name)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    // 检查子目录是否直接包含 .git
    if (existsSync(join(fullPath, '.git'))) return fullPath

    // 递归深入一层
    const found = findGitReposDown(fullPath, maxDepth - 1)
    if (found) return found
  }

  return null
}

/**
 * 获取单个文件的 unified diff
 */
export async function getFileDiff(dirPath: string, filePath: string, gitRoot?: string): Promise<string> {
  const root = gitRoot || findGitRoot(dirPath)
  if (!root) return ''
  if (!isPathSafe(root, filePath)) {
    console.warn('[git-diff-service] getFileDiff 拒绝不安全路径:', filePath)
    return ''
  }
  // git diff 用 `--` 分隔避免 filePath 被识别为选项
  const diff = runGitCommand(['diff', '--', filePath], root)
  return diff || ''
}

/**
 * 获取文件的旧版本（git HEAD）和新版本（磁盘）内容
 */
export async function getDiffContents(dirPath: string, filePath: string, gitRoot?: string): Promise<{ oldContent: string; newContent: string } | null> {
  const root = gitRoot || findGitRoot(dirPath)
  if (!root) return null
  if (!isPathSafe(root, filePath)) {
    console.warn('[git-diff-service] getDiffContents 拒绝不安全路径:', filePath)
    return null
  }

  // 旧版本从 git HEAD 读取
  let oldContent = ''
  try {
    const result = spawnSync('git', ['show', `HEAD:${filePath}`], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    if (result.status === 0) {
      oldContent = result.stdout
    }
  } catch {
    // 文件在 HEAD 中不存在（新文件）
  }

  // 新版本从磁盘读取
  let newContent = ''
  const fullPath = join(root, filePath)
  if (existsSync(fullPath)) {
    try {
      const st = statSync(fullPath)
      if (st.size > MAX_FILE_SIZE_BYTES) {
        console.warn('[git-diff-service] 文件超过大小上限，跳过读取:', fullPath, st.size)
      } else {
        newContent = readFileSync(fullPath, 'utf-8')
      }
    } catch {
      // 读取失败保持空字符串
    }
  }

  return { oldContent, newContent }
}

/**
 * 获取未追踪文件的内容（用于显示全绿新增 diff）
 *
 * filePath 应为相对于 gitRoot 或 dirPath 的相对路径。
 * 拒绝绝对路径和 `..` 穿越。
 */
export async function getUntrackedContent(dirPath: string, filePath: string, gitRoot?: string): Promise<string> {
  if (!filePath || typeof filePath !== 'string') return ''
  const root = gitRoot || findGitRoot(dirPath) || dirPath
  if (!isPathSafe(root, filePath)) {
    console.warn('[git-diff-service] getUntrackedContent 拒绝不安全路径:', filePath)
    return ''
  }
  const fullPath = resolve(root, filePath)
  try {
    const st = statSync(fullPath)
    if (st.size > MAX_FILE_SIZE_BYTES) {
      console.warn('[git-diff-service] 未追踪文件超过大小上限:', fullPath, st.size)
      return ''
    }
    return readFileSync(fullPath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 还原文件的未暂存变更
 */
export async function revertFile(dirPath: string, filePath: string, gitRoot?: string): Promise<void> {
  const root = gitRoot || findGitRoot(dirPath)
  if (!root) return
  if (!isPathSafe(root, filePath)) {
    console.warn('[git-diff-service] revertFile 拒绝不安全路径:', filePath)
    return
  }
  runGitCommand(['checkout', '--', filePath], root)
}
