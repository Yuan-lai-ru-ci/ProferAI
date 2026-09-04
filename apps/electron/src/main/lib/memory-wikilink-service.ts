/**
 * 记忆双链（[[...]]）解析服务。
 *
 * 让记忆面板支持 Obsidian 式双链：在 memory-archive 主题文件正文里写 `[[名称]]`
 * （可带 `[[名称|显示文本]]`），预览时渲染为可点击双链，点击后在面板内跳转到对应记忆文件；
 * 同时提供反链查询：给定当前文件，列出所有「引用过它」的其他记忆文件。
 *
 * 解析依据（按优先级）：
 * 1. frontmatter 的 `name:` 精确匹配；
 * 2. 文件名（不含 .md 后缀）精确匹配；
 * 3. name / 文件名 / description 包含匹配（兜底）。
 *
 * 目标范围：memory-archive 主题文件 + Profer Memory（.profer/memory；旧版 .claude/memory 由上层兼容迁移）下的 MEMORY.md 与主题文件。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, basename, resolve } from 'node:path'
import type { MemoryWikilinkTarget, MemoryBacklink } from '@profer/shared'

/** 单文件大小上限（2MB） */
const MAX_FILE_BYTES = 2 * 1024 * 1024

function relativeOf(dir: string, abs: string): string {
  const rel = abs.slice(dir.length)
  return rel.replace(/^[\\/]+/, '').split(/[\\/]/).join('/')
}

function collectMdFiles(dir: string): Array<{ relative: string; absolute: string }> {
  const out: Array<{ relative: string; absolute: string }> = []
  const walk = (current: string) => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        out.push({ relative: relativeOf(dir, abs), absolute: abs })
      }
    }
  }
  walk(dir)
  return out
}

interface MemoryFileMeta {
  relativePath: string
  absolutePath: string
  kind: 'archive' | 'auto'
  name: string
  stem: string
  description: string
}

function extractFrontmatter(text: string): { name?: string; title?: string; description?: string } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fm) return {}
  let name: string | undefined
  let title: string | undefined
  let description: string | undefined
  const lines = fm[1] ? fm[1].split('\n') : []
  for (const line of lines) {
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    const titleMatch = /^title:\s*(.+)$/.exec(line)
    const descMatch = /^description:\s*(.+)$/.exec(line)
    const clean = (v: string | undefined): string | undefined => v?.trim().replace(/^["']|["']$/g, '')
    if (nameMatch && nameMatch[1] && !name) name = clean(nameMatch[1])
    if (titleMatch && titleMatch[1] && !title) title = clean(titleMatch[1])
    if (descMatch && descMatch[1] && !description) description = clean(descMatch[1])
  }
  return { name, title, description }
}

function readSafe(file: string): string {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return ''
    return readFileSync(file, 'utf-8')
  } catch { return '' }
}

function indexMemoryDir(directory: string, kind: 'archive' | 'auto'): MemoryFileMeta[] {
  const out: MemoryFileMeta[] = []
  for (const file of collectMdFiles(directory)) {
    const text = readSafe(file.absolute)
    const { name, title, description } = extractFrontmatter(text)
    const stem = basename(file.relative, '.md')
    out.push({
      relativePath: file.relative,
      absolutePath: file.absolute,
      kind,
      name: name ?? title ?? stem,
      stem,
      description: description ?? '',
    })
  }
  return out
}

function indexAll(archiveDir: string, autoDir: string): MemoryFileMeta[] {
  return [...indexMemoryDir(archiveDir, 'archive'), ...(autoDir ? indexMemoryDir(autoDir, 'auto') : [])]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 解析双链名称到具体记忆文件。
 * @param archiveDir memory-archive 绝对路径
 * @param autoDir auto memory 绝对路径（可为空）
 * @param rawName `[[名称]]` 里的名称，未解码
 */
export function resolveMemoryWikilink(
  archiveDir: string,
  autoDir: string,
  rawName: string,
): MemoryWikilinkTarget | null {
  const name = rawName.trim()
  if (!name) return null
  const needle = name.toLowerCase()
  const all = indexAll(archiveDir, autoDir)
  if (!all.length) return null

  // 1. frontmatter name / stem 精确
  const byName = all.find((m) => m.name.toLowerCase() === needle)
  if (byName) return targetFrom(byName, 'name')
  const byStem = all.find((m) => m.stem.toLowerCase() === needle)
  if (byStem) return targetFrom(byStem, 'filename')
  // 2. 包含匹配（name / stem / description）
  const byContains = all.find(
    (m) => m.name.toLowerCase().includes(needle)
      || m.stem.toLowerCase().includes(needle)
      || m.description.toLowerCase().includes(needle),
  )
  if (byContains) return targetFrom(byContains, 'contains')
  return null
}

function targetFrom(meta: MemoryFileMeta, matchedBy: MemoryWikilinkTarget['matchedBy']): MemoryWikilinkTarget {
  return {
    relativePath: meta.relativePath,
    kind: meta.kind,
    name: meta.name,
    absolutePath: meta.absolutePath,
    matchedBy,
  }
}

/**
 * 反链：扫描全部记忆文件，找出正文里写了 `[[<currentLinkName>]]` 的其他文件（排除自身）。
 * @param currentAbsolutePath 当前打开文件的绝对路径（以此排除自身）
 * @param currentLinkName 用于匹配 `[[当前]]` 的名称，通常取当前文件 stem
 */
export function findMemoryBacklinks(
  archiveDir: string,
  autoDir: string,
  currentAbsolutePath: string,
  currentLinkName: string,
): MemoryBacklink[] {
  const needle = currentLinkName.trim()
  if (!needle) return []
  const needleL = needle.toLowerCase()
  const all = indexAll(archiveDir, autoDir)
  const self = all.find((m) => resolve(m.absolutePath) === resolve(currentAbsolutePath))
  const backlinks: MemoryBacklink[] = []
  for (const meta of all) {
    if (self && resolve(meta.absolutePath) === resolve(self.absolutePath)) continue
    const text = readSafe(meta.absolutePath)
    // 匹配 [[name]] 或 [[name|label]]（name 大小写不敏感）
    const pattern = new RegExp(`\\[\\[${escapeRegExp(needle)}(?:\\|[^\\[\\]]*)?\\]\\]`, 'ig')
    if (pattern.test(text)) {
      backlinks.push({ relativePath: meta.relativePath, kind: meta.kind, name: meta.name, absolutePath: meta.absolutePath })
    }
  }
  return backlinks
}

/** 判别某绝对路径是否属于 auto memory 目录（供调用方按域展示） */
export function memoryKindOfPath(autoDir: string, absolutePath: string): 'archive' | 'auto' {
  return autoDir && resolve(absolutePath).startsWith(resolve(autoDir) + resolve('/')) ? 'auto' : 'archive'
}
