import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DeckSourceKind, DeckSourceLineage, DeckSourceRecord, DeckSourceStatus } from '@profer/shared'
import { extractTextFromFile, isSupportedDocumentExtension } from './document-parser'

const DEFAULT_MAX_FILES = 100
const DEFAULT_MAX_BYTES_PER_FILE = 50 * 1024 * 1024
const TEXT_EXCERPT_LIMIT = 1_200
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'])
const DATA_EXTENSIONS = new Set(['.csv', '.tsv', '.json', '.xml'])

export interface InspectDeckSourcesInput {
  paths: string[]
  agentCwd: string
  allowedRoots: string[]
  maxFiles?: number
  maxBytesPerFile?: number
}

export interface InspectDeckSourcesResult {
  schemaVersion: 1
  sources: DeckSourceRecord[]
  conflicts: string[]
  gaps: string[]
}

interface Candidate extends DeckSourceRecord {
  groupKey: string
  rank: number
  hashes: string
}

function normalizePathForComparison(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithinRoot(root: string, target: string, allowRootItself = false): boolean {
  const rootKey = normalizePathForComparison(root)
  const targetKey = normalizePathForComparison(target)
  if (rootKey === targetKey) return allowRootItself
  const rootWithSep = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`
  return targetKey.startsWith(rootWithSep)
}

function realDirectory(path: string): string | undefined {
  try {
    const resolved = realpathSync(resolve(path))
    return statSync(resolved).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

function realFile(path: string): string | undefined {
  try {
    const resolved = realpathSync(resolve(path))
    return statSync(resolved).isFile() ? resolved : undefined
  } catch {
    return undefined
  }
}

function collectFiles(path: string, files: string[], gaps: string[], maxFiles: number): void {
  if (files.length >= maxFiles) {
    gaps.push(`文件数量达到上限 ${maxFiles}，其余文件未扫描`)
    return
  }

  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    gaps.push(`无法读取路径: ${path}`)
    return
  }

  // 先检查 lstat，再检查 realpath，防止目录内 symlink 逃逸到授权根之外。
  if (stat.isSymbolicLink()) return
  if (stat.isFile()) {
    files.push(path)
    return
  }
  if (!stat.isDirectory()) return

  let entries: string[]
  try {
    entries = readdirSync(path).sort((a, b) => a.localeCompare(b))
  } catch {
    gaps.push(`无法列出目录: ${path}`)
    return
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      gaps.push(`文件数量达到上限 ${maxFiles}，其余文件未扫描`)
      return
    }
    collectFiles(resolve(path, entry), files, gaps, maxFiles)
  }
}

function kindForPath(path: string): DeckSourceKind | null {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (DATA_EXTENSIONS.has(ext)) return 'data'
  if (['.xlsx', '.xlsm', '.xltx', '.xltm', '.ods', '.et', '.ett'].includes(ext)) return 'spreadsheet'
  if (['.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.odp', '.dps', '.dpt'].includes(ext)) return 'presentation'
  if (isSupportedDocumentExtension(ext)) return ext === '.txt' || ext === '.md' ? 'text' : 'document'
  return null
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function excerptForText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, TEXT_EXCERPT_LIMIT)
}

function extractVersionSignals(filePath: string, text: string): string[] {
  const signals: string[] = []
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const lowerName = name.toLowerCase()
  for (const match of lowerName.match(/20\d{2}[-_.]\d{1,2}[-_.]\d{1,2}/g) ?? []) signals.push(`filename-date:${match.replace(/[_.]/g, '-')}`)
  for (const match of lowerName.match(/(?:^|[-_.])v\d+(?:\.\d+)*|(?:^|[-_.])version[-_.]?\d+/g) ?? []) signals.push(`filename-version:${match}`)
  for (const word of ['final', 'latest', 'revised', '最新版', '定稿', 'draft', 'old', 'historical', '旧稿']) {
    if (lowerName.includes(word)) signals.push(`filename-status:${word}`)
  }

  const header = text.slice(0, 8_000).toLowerCase()
  for (const match of header.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g) ?? []) signals.push(`content-date:${match.replace(/[/.]/g, '-')}`)
  for (const match of header.match(/(?:版本|version)\s*[:：]?\s*v?\d+(?:\.\d+)*/g) ?? []) signals.push(`content-version:${match}`)
  for (const word of ['final', 'latest', 'revised', '最新版', '定稿', 'draft', 'old', 'historical', '旧稿']) {
    if (header.includes(word)) signals.push(`content-status:${word}`)
  }
  return [...new Set(signals)]
}

function groupKeyForPath(filePath: string): string {
  const raw = (filePath.split(/[\\/]/).pop() ?? filePath)
    .replace(extname(filePath), '')
    .replace(/20\d{2}[-_.]\d{1,2}[-_.]\d{1,2}/g, '')
  const tokens = raw.split(/[-_\s]+/).filter(Boolean)
  const kept: string[] = []
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (/^v?\d+(?:\.\d+)*$/.test(lower)) continue
    if (/^20\d{2}$/.test(lower) || /^(?:0?[1-9]|1[0-2])$/.test(lower) && kept.some((item) => /^20\d{2}$/.test(item))) continue
    if (/^(?:final|latest|revised|draft|old|historical|最新版|定稿|旧稿|a|b|copy|副本)$/i.test(lower)) continue
    kept.push(lower)
  }
  return kept.join('-') || raw.toLowerCase()
}

function scoreVersionSignals(signals: string[]): number {
  let score = 0
  for (const signal of signals) {
    if (/final|latest|revised|最新版|定稿/.test(signal)) score += 10_000
    if (/old|historical|旧稿|draft/.test(signal)) score -= 1_000
    const date = signal.match(/20(\d{2})[-_](\d{1,2})[-_](\d{1,2})/)
    if (date) score += Number(`${date[1]!}${date[2]!.padStart(2, '0')}${date[3]!.padStart(2, '0')}`)
    const version = signal.match(/(?:v|version[-_:\s]*)(\d+)/i)
    if (version) score += Number(version[1]) * 100
  }
  return score
}

function statusForGroup(items: Candidate[]): void {
  if (items.length === 1 && items[0]!.versionSignals?.some((signal) => /historical|旧稿/.test(signal))) {
    items[0]!.status = 'historical'
    return
  }

  const maxRank = Math.max(...items.map((item) => item.rank))
  const top = items.filter((item) => item.rank === maxRank)
  const topHashes = new Set(top.map((item) => item.contentHash))

  if (top.length > 1 && topHashes.size > 1) {
    for (const item of top) item.status = 'conflicted'
    for (const item of items.filter((item) => item.rank < maxRank)) item.status = item.status === 'historical' ? 'historical' : 'superseded'
    return
  }

  if (maxRank <= 0 && items.length === 1) {
    items[0]!.status = 'unknown'
    return
  }

  for (const item of items) {
    if (item.rank === maxRank) item.status = 'current'
    else item.status = item.status === 'historical' ? 'historical' : 'superseded'
  }
}

function relativePathFor(filePath: string, agentCwd: string): string {
  const value = relative(agentCwd, filePath).replace(/\\/g, '/')
  return value || (filePath.split(/[\\/]/).pop() ?? filePath)
}

function isAllowedFile(filePath: string, roots: string[]): boolean {
  return roots.some((root) => isWithinRoot(root, filePath))
}

/** Scan only authorized sources and classify their lineage without treating mtime as truth. */
export async function inspectDeckSources(input: InspectDeckSourcesInput): Promise<InspectDeckSourcesResult> {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytesPerFile = input.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
  if (!input.agentCwd.trim()) throw new Error('agentCwd 必填')
  if (maxFiles <= 0 || maxBytesPerFile <= 0) throw new Error('扫描上限必须大于 0')

  const cwd = realDirectory(input.agentCwd)
  if (!cwd) throw new Error('agentCwd 不存在或不是目录')
  const roots = [cwd, ...input.allowedRoots.map(realDirectory).filter((root): root is string => Boolean(root))]
  const files: string[] = []
  const gaps: string[] = []

  for (const requestedPath of input.paths) {
    if (!requestedPath?.trim()) continue
    const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath)
    const resolvedFile = realFile(absolute)
    const resolvedDir = realDirectory(absolute)
    if (resolvedFile) {
      if (isAllowedFile(resolvedFile, roots)) files.push(resolvedFile)
      continue
    }
    if (resolvedDir) {
      // 允许把授权根目录本身作为扫描入口；目录内的 symlink 仍在 collectFiles 中拒绝。
      if (roots.some((root) => isWithinRoot(root, resolvedDir, true))) collectFiles(resolvedDir, files, gaps, maxFiles)
      continue
    }
  }

  const uniqueFiles = [...new Set(files)].sort((a, b) => a.localeCompare(b))
  const candidates: Candidate[] = []
  for (const filePath of uniqueFiles) {
    if (!isAllowedFile(filePath, roots)) continue
    const kind = kindForPath(filePath)
    if (!kind) continue

    let stat: ReturnType<typeof statSync>
    let data: Buffer
    try {
      stat = statSync(filePath)
      if (stat.size > maxBytesPerFile) {
        gaps.push(`${relativePathFor(filePath, cwd)} 超过单文件大小上限 ${maxBytesPerFile} bytes，未读取`)
        continue
      }
      data = readFileSync(filePath)
    } catch {
      gaps.push(`无法读取文件: ${relativePathFor(filePath, cwd)}`)
      continue
    }

    const contentHash = sha256(data)
    let text = ''
    if (kind !== 'image') {
      try {
        text = await extractTextFromFile(filePath)
      } catch (error) {
        gaps.push(`${relativePathFor(filePath, cwd)} 文本提取失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const versionSignals = extractVersionSignals(filePath, text)
    const record: Candidate = {
      id: `src-${contentHash.slice(0, 16)}`,
      absolutePath: filePath,
      relativePath: relativePathFor(filePath, cwd),
      kind,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash,
      status: 'unknown',
      locator: kind === 'image' ? 'image' : 'document:excerpt',
      title: filePath.split(/[\\/]/).pop(),
      excerpt: text ? excerptForText(text) : undefined,
      versionSignals,
      groupKey: groupKeyForPath(filePath),
      rank: scoreVersionSignals(versionSignals),
      hashes: contentHash,
    }
    candidates.push(record)
  }

  const groups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.groupKey) ?? []
    group.push(candidate)
    groups.set(candidate.groupKey, group)
  }
  for (const group of groups.values()) statusForGroup(group)

  const conflicts = [...groups.entries()]
    .filter(([, items]) => items.some((item) => item.status === 'conflicted'))
    .map(([key]) => `来源组 ${key} 存在同等级且内容不同的版本冲突`)

  const sources = candidates
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map(({ groupKey: _groupKey, rank: _rank, hashes: _hashes, ...record }) => record)

  return { schemaVersion: 1, sources, conflicts, gaps: [...new Set(gaps)] }
}
