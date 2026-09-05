import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type AttachedProjectType = 'obsidian-vault' | 'git-repository' | 'node-project' | 'python-project'

export interface AttachedDirectoryProjectCandidate {
  rootPath: string
  type: AttachedProjectType
  evidence: string[]
  sourceDirectory: string
  /** 用于消歧的项目显示名；不是路径，不能替代 rootPath。 */
  name: string
  /** package.json 中的 name（若存在）。 */
  packageName?: string
  /** Git remote.origin.url（若能从本地 .git/config 读取）。 */
  gitRemote?: string
  /** 非 Git 子项目所属的最近 Git 根目录。 */
  repositoryRoot?: string
  /** 相对于用户附加目录的路径，便于区分同名目录。 */
  relativePath: string
}

const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
])
/** 防止把巨型挂载盘完整扫入 Agent prompt，同时避免旧的“前 200 个目录”随机漏项目。 */
const MAX_VISITED_DIRECTORIES = 2000
const MAX_SCAN_DEPTH = 3

type PackageManifest = {
  name?: unknown
  version?: unknown
  main?: unknown
  scripts?: unknown
  workspaces?: unknown
}

function readPackageManifest(directoryPath: string): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directoryPath, 'package.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as PackageManifest : undefined
  } catch {
    return undefined
  }
}

/** 只有带有项目身份的 package.json 才算 Node 项目，避免把依赖缓存/容器目录误报为项目。 */
function hasNodeProjectIdentity(manifest: PackageManifest | undefined): boolean {
  if (!manifest) return false
  if (typeof manifest.name === 'string' && manifest.name.trim()) return true
  if (typeof manifest.version === 'string' && manifest.version.trim()) return true
  if (typeof manifest.main === 'string' && manifest.main.trim()) return true
  if (manifest.scripts && typeof manifest.scripts === 'object') return Object.keys(manifest.scripts).length > 0
  return Array.isArray(manifest.workspaces) || Boolean(manifest.workspaces && typeof manifest.workspaces === 'object')
}

function readGitRemote(directoryPath: string): string | undefined {
  try {
    const gitEntry = join(directoryPath, '.git')
    const gitStat = statSync(gitEntry)
    let gitDir = gitEntry
    if (gitStat.isFile()) {
      const gitDirLine = readFileSync(gitEntry, 'utf8').match(/^gitdir:\s*(.+)\s*$/im)?.[1]
      if (!gitDirLine) return undefined
      gitDir = resolve(directoryPath, gitDirLine)
    }
    const config = readFileSync(join(gitDir, 'config'), 'utf8')
    const originSection = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[[^\]]+\]|$)/i)?.[1]
    return originSection?.match(/^\s*url\s*=\s*(.+?)\s*$/im)?.[1]
  } catch {
    return undefined
  }
}

function detectProjectAt(directoryPath: string, sourceDirectory: string): AttachedDirectoryProjectCandidate | undefined {
  const evidence: string[] = []
  let type: AttachedProjectType | undefined
  const packageManifest = readPackageManifest(directoryPath)
  const hasObsidian = existsSync(join(directoryPath, '.obsidian'))
  const hasGit = existsSync(join(directoryPath, '.git'))
  const hasNode = hasNodeProjectIdentity(packageManifest)

  if (hasObsidian) {
    type = 'obsidian-vault'
    evidence.push('.obsidian/')
  } else if (hasGit) {
    type = 'git-repository'
    evidence.push('.git/')
  } else if (hasNode) {
    type = 'node-project'
    evidence.push('package.json')
  } else if (existsSync(join(directoryPath, 'pyproject.toml'))) {
    type = 'python-project'
    evidence.push('pyproject.toml')
  } else if (existsSync(join(directoryPath, 'requirements.txt'))) {
    type = 'python-project'
    evidence.push('requirements.txt')
  }

  if (!type) return undefined
  const packageName = typeof packageManifest?.name === 'string' && packageManifest.name.trim()
    ? packageManifest.name.trim()
    : undefined
  const gitRemote = hasGit ? readGitRemote(directoryPath) : undefined
  const name = packageName ?? basename(directoryPath)
  return {
    rootPath: directoryPath,
    type,
    evidence,
    sourceDirectory,
    name,
    ...(packageName ? { packageName } : {}),
    ...(gitRemote ? { gitRemote } : {}),
    relativePath: relative(sourceDirectory, directoryPath) || '.',
  }
}

/**
 * 对已授权附加目录做有限深度、只读的项目标志扫描。
 * 扫描结果只用于 Agent 上下文，不会改变 cwd 或写入用户目录。
 */
export function detectAttachedDirectoryProjects(directories: string[]): AttachedDirectoryProjectCandidate[] {
  const candidates = new Map<string, AttachedDirectoryProjectCandidate>()
  const sourceDirectories = directories.map((directory) => resolve(directory))
  const gitRoots: string[] = []
  let visitedDirectories = 0

  const visit = (directoryPath: string, sourceDirectory: string, depth: number): void => {
    if (visitedDirectories >= MAX_VISITED_DIRECTORIES) return
    const normalizedPath = resolve(directoryPath)
    try {
      if (!statSync(normalizedPath).isDirectory()) return
    } catch {
      return
    }
    if (candidates.has(normalizedPath) && depth > 0) return
    visitedDirectories++

    const candidate = detectProjectAt(normalizedPath, sourceDirectory)
    if (candidate && !candidates.has(normalizedPath)) {
      candidates.set(normalizedPath, candidate)
      if (candidate.type === 'git-repository') gitRoots.push(normalizedPath)
    }
    if (depth >= MAX_SCAN_DEPTH) return

    let entries: Dirent<string>[]
    try {
      // 排序后再受全局预算限制，避免 readdir 返回顺序导致“经常读错/漏掉”路径。
      entries = readdirSync(normalizedPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORY_NAMES.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }

    for (const entry of entries) {
      if (visitedDirectories >= MAX_VISITED_DIRECTORIES) break
      visit(join(normalizedPath, entry.name), sourceDirectory, depth + 1)
    }
  }

  for (const sourceDirectory of sourceDirectories) {
    visit(sourceDirectory, sourceDirectory, 0)
  }

  // 为 Node/Python 子项目标记最近的 Git 根，给 Agent 一个确定的“repo vs 子项目”关系。
  for (const [path, candidate] of candidates) {
    if (candidate.type === 'git-repository') continue
    const repositoryRoot = gitRoots
      .filter((root) => {
        const relativePath = relative(root, path)
        return relativePath === '' || (
          relativePath !== '..' &&
          !relativePath.startsWith(`..${sep}`) &&
          !isAbsolute(relativePath)
        )
      })
      .sort((a, b) => b.length - a.length)[0]
    if (repositoryRoot) candidates.set(path, { ...candidate, repositoryRoot })
  }

  const sourceOrder = new Map(sourceDirectories.map((source, index) => [source, index]))
  return [...candidates.values()].sort((a, b) => {
    const order = (sourceOrder.get(a.sourceDirectory) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(b.sourceDirectory) ?? Number.MAX_SAFE_INTEGER)
    if (order !== 0) return order
    return a.rootPath.localeCompare(b.rootPath)
  })
}
