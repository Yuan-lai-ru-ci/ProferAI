/**
 * Git Diff 服务
 *
 * 提供工作区文件变更检测、diff 获取、文件还原等 Git 操作。
 * 复用 git-detector.ts 中 runGitCommand 的 spawnSync 模式。
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { ChangedFileEntry, UnstagedChangesResult } from '@proma/shared'
import type { ChangeSource, ChangedFileStatus } from '@proma/shared'

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
 */
function computeSource(
  filePath: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
): ChangeSource {
  let inSession = false
  let inWorkspace = false

  if (sessionPath) {
    const normalized = sessionPath.endsWith('/') ? sessionPath : sessionPath + '/'
    if (filePath.startsWith(normalized)) {
      inSession = true
    }
  }

  if (workspaceFilesPath) {
    const normalized = workspaceFilesPath.endsWith('/') ? workspaceFilesPath : workspaceFilesPath + '/'
    if (filePath.startsWith(normalized)) {
      inWorkspace = true
    }
  }

  if (inSession && inWorkspace) return 'both'
  if (inSession) return 'session'
  if (inWorkspace) return 'workspace'
  return 'none'
}

/**
 * 获取未暂存的文件变更列表
 */
export async function getUnstagedChanges(
  dirPath: string,
  sessionPath?: string,
  workspaceFilesPath?: string,
): Promise<UnstagedChangesResult> {
  // 尝试多个候选路径来查找 Git 仓库
  const candidates = [dirPath, sessionPath, workspaceFilesPath].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  )
  let gitRoot: string | null = null

  for (const cand of candidates) {
    gitRoot = findGitRoot(cand)
    if (gitRoot) break
  }

  if (!gitRoot) {
    return { isGitRepo: false, files: [], untrackedFiles: [] }
  }

  // 获取变更文件列表 (M=modified, D=deleted)
  const nameStatus = runGitCommand(['diff', '--name-status'], gitRoot)
  // 获取行数统计
  const numStat = runGitCommand(['diff', '--numstat'], gitRoot)

  const files: ChangedFileEntry[] = []

  if (nameStatus) {
    const statusLines = nameStatus.split('\n').filter(Boolean)
    const numStatLines = numStat ? numStat.split('\n').filter(Boolean) : []

    for (let i = 0; i < statusLines.length; i++) {
      const statusLine = statusLines[i]!
      // 格式: "M\tfile/path.ts" 或 "D\tfile/path.ts"
      const statusMatch = statusLine.match(/^([MD])\t(.+)$/)
      if (!statusMatch) continue

      const status: ChangedFileStatus = statusMatch[1] === 'D' ? 'deleted' : 'modified'
      const filePath = statusMatch[2]!

      let additions = 0
      let deletions = 0

      if (i < numStatLines.length) {
        // 格式: "3\t2\tfile/path.ts" (additions\deletions\file)
        const parts = numStatLines[i]!.split('\t')
        if (parts.length >= 2) {
          const addNum = parseInt(parts[0]!, 10)
          const delNum = parseInt(parts[1]!, 10)
          if (!isNaN(addNum)) additions = addNum
          if (!isNaN(delNum)) deletions = delNum
        }
      }

      files.push({
        filePath,
        status,
        additions,
        deletions,
        source: computeSource(filePath, sessionPath, workspaceFilesPath),
      })
    }
  }

  // 获取未追踪文件
  const untrackedOutput = runGitCommand(['ls-files', '--others', '--exclude-standard'], gitRoot)
  const untrackedFiles = untrackedOutput ? untrackedOutput.split('\n').filter(Boolean) : []

  return { isGitRepo: true, files, untrackedFiles }
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
export async function getFileDiff(dirPath: string, filePath: string): Promise<string> {
  const gitRoot = findGitRoot(dirPath)
  if (!gitRoot) return ''
  const diff = runGitCommand(['diff', '--', filePath], gitRoot)
  return diff || ''
}

/**
 * 获取未追踪文件的内容（用于显示全绿新增 diff）
 */
export async function getUntrackedContent(dirPath: string, filePath: string): Promise<string> {
  const content = readFileSync(filePath, 'utf-8')
  return content
}

/**
 * 还原文件的未暂存变更
 */
export async function revertFile(dirPath: string, filePath: string): Promise<void> {
  const gitRoot = findGitRoot(dirPath)
  if (!gitRoot) return
  runGitCommand(['checkout', '--', filePath], gitRoot)
}
