import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'

export type AttachedProjectType = 'obsidian-vault' | 'git-repository' | 'node-project' | 'python-project'

export interface AttachedDirectoryProjectCandidate {
  rootPath: string
  type: AttachedProjectType
  evidence: string[]
  sourceDirectory: string
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
const MAX_CHILDREN_PER_DIRECTORY = 200
const MAX_SCAN_DEPTH = 2

function detectProjectAt(directoryPath: string, sourceDirectory: string): AttachedDirectoryProjectCandidate | undefined {
  const evidence: string[] = []
  let type: AttachedProjectType | undefined

  if (existsSync(join(directoryPath, '.obsidian'))) {
    type = 'obsidian-vault'
    evidence.push('.obsidian/')
  } else if (existsSync(join(directoryPath, '.git'))) {
    type = 'git-repository'
    evidence.push('.git/')
  } else if (existsSync(join(directoryPath, 'package.json'))) {
    type = 'node-project'
    evidence.push('package.json')
  } else if (existsSync(join(directoryPath, 'pyproject.toml'))) {
    type = 'python-project'
    evidence.push('pyproject.toml')
  } else if (existsSync(join(directoryPath, 'requirements.txt'))) {
    type = 'python-project'
    evidence.push('requirements.txt')
  }

  return type ? { rootPath: directoryPath, type, evidence, sourceDirectory } : undefined
}

/**
 * 对已授权附加目录做有限深度、只读的项目标志扫描。
 * 扫描结果只用于 Agent 上下文，不会改变 cwd 或写入用户目录。
 */
export function detectAttachedDirectoryProjects(directories: string[]): AttachedDirectoryProjectCandidate[] {
  const candidates = new Map<string, AttachedDirectoryProjectCandidate>()

  const visit = (directoryPath: string, sourceDirectory: string, depth: number): void => {
    const normalizedPath = resolve(directoryPath)
    if (!existsSync(normalizedPath)) return

    const candidate = detectProjectAt(normalizedPath, sourceDirectory)
    if (candidate && !candidates.has(normalizedPath)) candidates.set(normalizedPath, candidate)
    if (depth >= MAX_SCAN_DEPTH) return

    let entries: Dirent<string>[]
    try {
      entries = readdirSync(normalizedPath, { withFileTypes: true }).slice(0, MAX_CHILDREN_PER_DIRECTORY)
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
      visit(join(normalizedPath, entry.name), sourceDirectory, depth + 1)
    }
  }

  for (const directory of directories) visit(directory, resolve(directory), 0)

  return [...candidates.values()].sort((a, b) => {
    const sourceOrder = directories.indexOf(a.sourceDirectory) - directories.indexOf(b.sourceDirectory)
    if (sourceOrder !== 0) return sourceOrder
    return a.rootPath.localeCompare(b.rootPath)
  })
}
