import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, basename } from 'node:path'
import type {
  KnowledgeImportBatchResult,
  KnowledgeItem,
  KnowledgeItemKind,
  KnowledgeLibraryIndex,
  KnowledgeLibrarySnapshot,
  KnowledgeSearchResult,
  KnowledgeReference,
  PaperMeta,
} from '@profer/shared'
import {
  getKnowledgeBaseDir,
  getKnowledgeItemDir,
  getKnowledgeItemsIndexPath,
  resolveKnowledgeItemDir,
} from './config-paths'
import { extractTextFromFile, isSupportedDocumentExtension } from './document-parser'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

const INDEX_VERSION = 1 as const
const MAX_IMPORT_ITEMS = 10
const MAX_ITEM_FILE_SIZE = 100 * 1024 * 1024
const MAX_RESULT_CHARS = 12_000
const MAX_CHUNK_CHARS = 1_500

function kindForExtension(ext: string): KnowledgeItemKind | null {
  if (ext === '.pdf') return 'pdf'
  if (['.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm', '.rtf'].includes(ext)) return 'word'
  if (['.wps', '.wpt'].includes(ext)) return 'wps'
  if (['.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.odp', '.dps', '.dpt'].includes(ext)) return 'presentation'
  if (['.xlsx', '.xlsm', '.xltx', '.xltm', '.ods', '.et', '.ett'].includes(ext)) return 'spreadsheet'
  if (ext === '.md') return 'markdown'
  if (ext === '.txt') return 'text'
  return null
}

function mediaTypeForExtension(ext: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return types[ext] ?? 'application/octet-stream'
}

function normalizeItem(value: unknown): KnowledgeItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<KnowledgeItem>
  if (typeof item.id !== 'string' || typeof item.title !== 'string' || !item.id || !item.title) return null
  if (!['pdf', 'word', 'wps', 'presentation', 'spreadsheet', 'markdown', 'text'].includes(String(item.kind))) return null
  if (item.origin !== 'local' && item.origin !== 'arxiv') return null
  return {
    id: item.id,
    title: item.title.slice(0, 500),
    kind: item.kind as KnowledgeItemKind,
    origin: item.origin,
    originalFileName: typeof item.originalFileName === 'string' ? item.originalFileName.slice(0, 500) : undefined,
    mediaType: typeof item.mediaType === 'string' ? item.mediaType.slice(0, 200) : undefined,
    fileSize: Number.isFinite(item.fileSize) && item.fileSize! >= 0 ? item.fileSize! : 0,
    importedAt: Number.isFinite(item.importedAt) ? item.importedAt! : 0,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt! : 0,
    tags: Array.isArray(item.tags) ? [...new Set(item.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))].slice(0, 30) : [],
    research: item.research,
    remoteId: typeof item.remoteId === 'string' ? item.remoteId : undefined,
    syncState: item.syncState === 'synced' || item.syncState === 'failed' ? item.syncState : 'local-only',
    syncError: typeof item.syncError === 'string' ? item.syncError.slice(0, 500) : undefined,
    lastSyncAttemptAt: Number.isFinite(item.lastSyncAttemptAt) ? item.lastSyncAttemptAt : undefined,
  }
}

function readIndex(): KnowledgeLibraryIndex {
  const raw = readJsonFileSafe<unknown>(getKnowledgeItemsIndexPath())
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: INDEX_VERSION, items: [] }
  const candidate = raw as Partial<KnowledgeLibraryIndex>
  const items = Array.isArray(candidate.items) ? candidate.items.map(normalizeItem).filter((item): item is KnowledgeItem => item !== null) : []
  return { version: INDEX_VERSION, items }
}

function writeIndex(index: KnowledgeLibraryIndex): void {
  writeJsonFileAtomic(getKnowledgeItemsIndexPath(), index)
}

/** 旧 Paperpipe 索引也属于用户现有资料；只读投影，不隐式迁移或写入新索引。 */
function readLegacyPaperItems(): KnowledgeItem[] {
  const legacy = readJsonFileSafe<unknown>(join(getKnowledgeBaseDir(), 'index.json'))
  if (!Array.isArray(legacy)) return []
  return legacy.filter((value): value is PaperMeta => !!value && typeof value === 'object' && typeof (value as PaperMeta).id === 'string').map((paper) => ({
    id: paper.id,
    title: paper.title || '未命名研究资料',
    kind: 'pdf' as const,
    origin: paper.source === 'arxiv' ? 'arxiv' as const : 'local' as const,
    originalFileName: paper.originalFileName,
    mediaType: 'application/pdf',
    fileSize: 0,
    importedAt: paper.importedAt || 0,
    updatedAt: paper.importedAt || 0,
    tags: paper.tags || [],
    research: paper.source === 'arxiv' || paper.arxivId ? { arxivId: paper.arxivId, doi: paper.doi, authors: paper.authors, abstract: paper.abstract, year: paper.year } : undefined,
    remoteId: paper.remoteId,
    syncState: paper.syncState === 'synced' || paper.syncState === 'failed' ? paper.syncState : 'local-only' as const,
    syncError: paper.syncError,
    lastSyncAttemptAt: paper.lastSyncAttemptAt,
  }))
}

function allKnowledgeItems(): KnowledgeItem[] {
  const current = readIndex().items
  const known = new Set(current.map((item) => item.id))
  return [...current, ...readLegacyPaperItems().filter((item) => !known.has(item.id))]
}

function itemTextPath(itemId: string): string {
  return join(resolveKnowledgeItemDir(itemId), 'extracted.txt')
}

function safeTitle(fileName: string): string {
  return basename(fileName, extname(fileName)).trim().slice(0, 500) || '未命名资料'
}

/** 根据不可信 renderer ID 重建轻量引用；展示字段只取本地索引事实。 */
export function resolveKnowledgeReferences(itemIds: string[]): KnowledgeReference[] {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0 || ids.length > MAX_IMPORT_ITEMS) throw new Error('资料引用数量必须为 1–10 项')
  const items = new Map(allKnowledgeItems().map((item) => [item.id, item]))
  const references: KnowledgeReference[] = []
  for (const id of ids) {
    const item = items.get(id)
    // 引用的存在性由索引决定，而不是要求此刻同步读取正文：
    // 历史 arXiv 正文可能只在 Paperpipe 远端，不能因此拒绝用户把它加入会话。
    if (!item) continue
    references.push({ itemId: item.id, title: item.title, kind: item.kind, origin: item.origin, importedAt: Date.now() })
  }
  if (references.length === 0) throw new Error('所选资料不存在或已删除')
  return references
}

export function listKnowledgeItems(): KnowledgeItem[] {
  return allKnowledgeItems().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getKnowledgeLibrarySnapshot(): KnowledgeLibrarySnapshot {
  const items = listKnowledgeItems()
  return { items, totalItems: items.length }
}

export async function importKnowledgeItems(filePaths: string[]): Promise<KnowledgeImportBatchResult> {
  if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > MAX_IMPORT_ITEMS) {
    throw new Error(`一次最多导入 ${MAX_IMPORT_ITEMS} 份资料`)
  }
  const results: KnowledgeImportBatchResult['results'] = []
  for (const filePath of filePaths) {
    try {
      results.push({ filePath, item: await importOneKnowledgeItem(filePath) })
    } catch (error) {
      results.push({ filePath, error: error instanceof Error ? error.message : '资料导入失败' })
    }
  }
  return { results }
}

async function importOneKnowledgeItem(filePath: string): Promise<KnowledgeItem> {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('资料路径无效')
  const ext = extname(filePath).toLowerCase()
  const kind = kindForExtension(ext)
  if (!kind || !isSupportedDocumentExtension(ext)) throw new Error(`暂不支持导入 ${ext || '该'} 格式`)
  if (!existsSync(filePath)) throw new Error('资料文件不存在')
  const stats = statSync(filePath)
  if (!stats.isFile() || stats.size <= 0) throw new Error('资料文件为空或不可读取')
  if (stats.size > MAX_ITEM_FILE_SIZE) throw new Error('资料文件超过 100MB 上限')

  const text = await extractTextFromFile(filePath)
  if (!text.trim()) throw new Error('资料解析后内容为空')

  const id = randomUUID()
  const dir = getKnowledgeItemDir(id)
  const originalName = basename(filePath)
  const storedName = `original${ext}`
  copyFileSync(filePath, join(dir, storedName))
  writeFileSync(join(dir, 'extracted.txt'), text, 'utf-8')

  const now = Date.now()
  const item: KnowledgeItem = {
    id,
    title: safeTitle(originalName),
    kind,
    origin: 'local',
    originalFileName: originalName,
    mediaType: mediaTypeForExtension(ext),
    fileSize: stats.size,
    importedAt: now,
    updatedAt: now,
    tags: [],
    syncState: 'local-only',
  }
  const index = readIndex()
  index.items.unshift(item)
  writeIndex(index)
  return item
}

export function getKnowledgeItem(itemId: string): { meta: KnowledgeItem; text: string } | null {
  const item = allKnowledgeItems().find((candidate) => candidate.id === itemId)
  if (!item) return null
  try {
    if (readIndex().items.some((candidate) => candidate.id === itemId)) {
      return { meta: item, text: readFileSync(itemTextPath(itemId), 'utf-8') }
    }
    // 历史论文正文继续由既有 Paperpipe 路径负责；本地有缓存时可参与 Chat 片段检索。
    return { meta: item, text: readFileSync(join(getKnowledgeBaseDir(), 'papers', itemId, 'full.md'), 'utf-8') }
  } catch {
    return null
  }
}

export function deleteKnowledgeItem(itemId: string): { itemId: string; deleted: boolean } {
  const index = readIndex()
  if (!index.items.some((item) => item.id === itemId)) throw new Error('资料不存在')
  rmSync(resolveKnowledgeItemDir(itemId), { recursive: true, force: true })
  writeIndex({ version: INDEX_VERSION, items: index.items.filter((item) => item.id !== itemId) })
  return { itemId, deleted: true }
}

function keywords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[\s,，。；;:：!?！？()（）\[\]{}]+/).map((part) => part.trim()).filter((part) => part.length >= 2))].slice(0, 12)
}

function scoreKnowledgeText(item: KnowledgeItem, text: string, terms: string[]): KnowledgeSearchResult | null {
  const normalized = text.trim()
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0)
  const titleMatches = terms.filter((term) => item.title.toLowerCase().includes(term)).length

  // “总结这篇文章”这类问题通常不会复述正文关键词。资料既然作为本轮附件，
  // 就必须至少提供开头的标题/摘要/正文窗口，不能因词面不匹配而静默丢失。
  const hasLexicalMatch = positions.length > 0 || titleMatches > 0
  const position = positions.length ? Math.min(...positions) : 0
  const start = hasLexicalMatch ? Math.max(0, position - 300) : 0
  const end = Math.min(normalized.length, start + MAX_CHUNK_CHARS)
  return {
    item,
    content: normalized.slice(start, end),
    startIndex: start,
    endIndex: end,
    score: hasLexicalMatch ? positions.length + titleMatches * 0.5 : 0,
  }
}

export function searchKnowledgeItems(query: string, allowedItemIds?: string[], topK = 5): KnowledgeSearchResult[] {
  const terms = keywords(query)
  if (!terms.length) return []
  const allowed = allowedItemIds ? new Set(allowedItemIds) : null
  const results: KnowledgeSearchResult[] = []
  let totalChars = 0
  for (const item of listKnowledgeItems().filter((candidate) => !allowed || allowed.has(candidate.id))) {
    const loaded = getKnowledgeItem(item.id)
    if (!loaded) continue
    const result = scoreKnowledgeText(item, loaded.text, terms)
    if (!result || totalChars + result.content.length > MAX_RESULT_CHARS) continue
    totalChars += result.content.length
    results.push(result)
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.min(topK, 20))
}

/**
 * Chat 专用异步检索：只对会话 allowlist 中的历史 Paperpipe 项按需拉取正文。
 * 绝不接受任意目录或任意 remoteId，所有候选项先由本地索引约束。
 */
export async function searchKnowledgeItemsForChat(query: string, allowedItemIds: string[], topK = 5): Promise<KnowledgeSearchResult[]> {
  const terms = keywords(query)
  if (!terms.length || !allowedItemIds.length) return []
  const allowed = new Set(allowedItemIds)
  const results: KnowledgeSearchResult[] = []
  let totalChars = 0
  for (const item of listKnowledgeItems().filter((candidate) => allowed.has(candidate.id))) {
    let text = getKnowledgeItem(item.id)?.text
    if (!text && !readIndex().items.some((candidate) => candidate.id === item.id)) {
      try {
        const { getPaper } = await import('./kb-paperpipe')
        text = (await getPaper(item.id))?.markdown
      } catch {
        // 单篇研究资料暂不可读时跳过，不能中断用户原问题。
      }
    }
    if (!text) continue
    const result = scoreKnowledgeText(item, text, terms)
    if (!result || totalChars + result.content.length > MAX_RESULT_CHARS) continue
    totalChars += result.content.length
    results.push(result)
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.min(topK, 20))
}
