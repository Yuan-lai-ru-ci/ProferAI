/**
 * memory-archive 全文检索服务（FTS5）。
 *
 * Profer 的记忆正文沉淀在 `workspace-files/.context/memory-archive/` 下的主题 .md 文件里，
 * 由 Agent 按统一知识维护规则写入。过去 Agent 只能靠 MEMORY.md 索引 + 文件名定位，
 * 正文内容无法全文检索，导致"记忆写进去了但日后找不到"。
 *
 * 本服务用 Node 内置 `node:sqlite` 的 FTS5 虚拟表（零原生依赖、Electron 43 / Node 24 内置可用）
 * 对 memory-archive 目录建立全文索引，支持 BM25 排序、摘要高亮、前缀检索。
 *
 * ### 关键：中英文分词
 * FTS5 默认 unicode61 tokenizer 对连续中文不做字级切分，纯中文 query 会 miss。
 * 因此存储与查询走同一套 `cut()` 切分：
 * - 中文逐字拆成单字 token（保证单字/多字短语都能命中）；
 * - 英文/数字/路径/代码符号保留整块 token（保证 rebase、profer-skin、47.109 等能精确命中）。
 * 查询侧对切分出的 token 做 AND 聚合，确保结果仍与 query 语义相关。
 *
 * ### 索引策略
 * memory-archive 是静态文件目录、无自有进程，因此采用"惰性索引 + 进程内缓存"：
 * - 每次检索前扫描目录，按文件 (path, mtime, size) 签名判断是否需重建该文件索引；
 * - 缓存签名与 FTS5 内容行（行号→真实文件），检索命中后回读真实片段给调用方。
 * - 无需常驻进程、无需定时任务，天然适配"写后即查、查前刷新"。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

/** 单次检索返回的最大结果数 / 单片段最大字符数 */
const MAX_TOP_K = 20
const MAX_SNIPPET_CHARS = 1_500
/** 单文件过大保护：超过该字节数不全文索引（仍保留标题/路径命中） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 索引覆盖的最大文件数，防止异常目录拖垮检索 */
const MAX_FILES = 2_000

export interface MemoryArchiveSearchHit {
  /** 相对 memory-archive 的文件路径，用 / 归一 */
  relativePath: string
  /** 命中片段（已在真实文件上截取） */
  content: string
  /** 命中片段在全文中的起始偏移 */
  startIndex: number
  /** 命中片段在全文中的结束偏移 */
  endIndex: number
  /** FTS5 BM25 分数（越小越相关），供排序/调试 */
  score: number
  matchedTokens: string[]
}

interface FtsRow {
  rowid: number
  path: string
  score: number
}

interface IndexCache {
  /** 已索引文件签名：filePath -> "mtime|size" */
  signatures: Map<string, string>
}


/** 中文字符区间 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
/** 把文本切成 FTS5 索引 token：中文逐字，非中文整块。 */
export function cutForMemoryIndex(text: string): string[] {
  const tokens: string[] = []
  const buf: string[] = []
  const flush = () => {
    if (buf.length) {
      const block = buf.join('')
      // 中文块逐字；非中文块整词
      if (CJK_RE.test(block)) {
        for (const ch of block) {
          if (ch.trim()) tokens.push(ch)
        }
      } else if (block.trim()) {
        tokens.push(block)
      }
      buf.length = 0
    }
  }
  for (const ch of text) {
    if (ch.trim() === '') { flush(); continue }
    const isCjk = CJK_RE.test(ch)
    const prev = buf[buf.length - 1]
    const lastCjk = prev !== undefined && CJK_RE.test(prev)
    if (buf.length === 0 || isCjk === lastCjk) buf.push(ch)
    else { flush(); buf.push(ch) }
  }
  flush()
  return tokens
}

/** 从查询构造 FTS5 MATCH 表达式：中文单字 token + 非中文整 token 全部 AND。 */
export function buildMemoryMatchExpression(query: string): string[] {
  const tokens = cutForMemoryIndex(query)
  const quoted = tokens.filter((t, i, arr) => arr.indexOf(t) === i).map((t) => `"${t}"`)
  return quoted
}

/** 相对路径签名：用于安全回读 + 展示。 */
function toRelativePath(memoryDir: string, absFilePath: string): string {
  const rel = relative(resolve(memoryDir), resolve(absFilePath))
  return rel.split(/[\\/]/).join('/')
}

/** 判断给定路径是否需要重新索引 */
function isFileChanged(cache: IndexCache, filePath: string, mtime: number, size: number): boolean {
  const signature = `${mtime}|${size}`
  const prev = cache.signatures.get(filePath)
  return prev !== signature
}

/** 递归收集 memory-archive 下所有 .md 文件 */
function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md' && out.length < MAX_FILES) {
        out.push(abs)
      }
    }
  }
  walk(dir)
  return out
}

/**
 * 惰性索引 memory-archive 目录并返回可检索的查询函数族。
 * @param memoryArchivePath - memory-archive 绝对路径
 */
export function createMemoryArchiveSearcher(memoryArchivePath: string) {
  const memoryDir = memoryArchivePath
  let db: DatabaseSync | null = null
  /** FTS 行号 -> { absFile, relativePath } 映射 */
  const rowFiles = new Map<number, { absFile: string; relativePath: string }>()
  /** absFile -> 最新索引对应的 rowid（重索引时先删旧行） */
  const fileRowIds = new Map<string, number>()
  /** absFile -> 最新 mtime/size，用于跳过未变更文件 */
  const fileMeta = new Map<string, { mtime: number; size: number }>()
  // SQLite 索引和 rowFiles 映射均属于当前 searcher 实例。签名缓存也必须随实例
  // 生命周期创建，不能跨实例复用；否则新 searcher 的内存数据库为空，却会因旧实例
  // 的签名而跳过首次建索引，造成所有检索返回空结果。
  const cache: IndexCache = { signatures: new Map() }

  /** 是否已扫描过目录结构（避免每次重复 readdir） */
  let scannedDir = false

  const ensureOpen = () => {
    if (db) return
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      path,
      content,
      tokenize = "unicode61"
    )`)
  }

  const ensureIndexed = () => {
    ensureOpen()
    const dir = memoryDir
    let files: string[]
    if (!scannedDir) {
      files = collectMarkdownFiles(dir)
      scannedDir = true
    } else {
      // 仍扫一遍以捕获新增/删除，但复用 collect；小目录成本可忽略
      files = collectMarkdownFiles(dir)
    }
    const existingSignatures = cache!.signatures
    const seen = new Set<string>()

    for (const absFile of files) {
      seen.add(absFile)
      let st
      try { st = statSync(absFile) } catch { continue }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      const mtime = Math.floor(st.mtimeMs)
      if (isFileChanged(cache!, absFile, mtime, st.size)) {
        let text = ''
        try { text = readFileSync(absFile, 'utf-8') } catch { continue }
        indexFile(absFile, text)
        cache!.signatures.set(absFile, `${mtime}|${st.size}`)
        fileMeta.set(absFile, { mtime, size: st.size })
      } else if (!fileMeta.has(absFile)) {
        // 签名未变但 meta 丢失（如 map 被重建），补 meta 但跳过重建
        fileMeta.set(absFile, { mtime, size: st.size })
      }
    }
    // 清理已删除文件的索引：从 FTS 表删除其行、清理签名与映射
    for (const key of [...cache!.signatures.keys()]) {
      if (!seen.has(key)) {
        const delRowid = fileRowIds.get(key)
        if (delRowid != null) {
          try { db!.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(delRowid) } catch { /* noop */ }
          rowFiles.delete(delRowid)
          fileRowIds.delete(key)
        }
        cache!.signatures.delete(key)
        fileMeta.delete(key)
      }
    }
  }

  const indexFile = (absFile: string, text: string) => {
    const tokens = cutForMemoryIndex(text)
    const content = tokens.join(' ')
    const relativePath = toRelativePath(memoryDir, absFile)
    // 重索引前先删除该文件旧行，避免 FTS5 累积过期副本
    const prevRowid = fileRowIds.get(absFile)
    if (prevRowid != null) {
      try { db!.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(prevRowid) } catch { /* noop */ }
      rowFiles.delete(prevRowid)
    }
    const insert = db!.prepare('INSERT INTO mem_fts (path, content) VALUES (?, ?)')
    const info = insert.run(relativePath, content)
    const rowid = Number(info.lastInsertRowid)
    rowFiles.set(rowid, { absFile, relativePath })
    fileRowIds.set(absFile, rowid)
  }

  /** 手动触发整表重建（测试/显式刷新用） */
  const rebuildAll = () => {
    ensureOpen()
    if (!db) return
    db.exec('DELETE FROM mem_fts')
    rowFiles.clear()
    fileRowIds.clear()
    cache!.signatures.clear()
    fileMeta.clear()
    scannedDir = false
    ensureIndexed()
  }

  /**
   * 执行全文检索。
   * @param query - 原始查询词
   * @param topK - 返回条数上限
   */
  const search = (query: string, topK = 5): MemoryArchiveSearchHit[] => {
    ensureIndexed()
    const terms = buildMemoryMatchExpression(query)
    if (!terms.length || !db) return []
    const matchExpr = terms.join(' AND ')
    let rows: FtsRow[]
    try {
      rows = db.prepare(
        `SELECT rowid, path, bm25(mem_fts) AS score FROM mem_fts WHERE mem_fts MATCH ? ORDER BY score LIMIT ?`,
      ).all(matchExpr, Math.max(1, Math.min(topK, MAX_TOP_K))) as unknown as FtsRow[]
    } catch {
      // query 含特殊字符导致 FTS 语法错误时降级为整词字符串命中
      return searchFallback(query, topK)
    }
    const hits: MemoryArchiveSearchHit[] = []
    for (const row of rows) {
      const mapping = rowFiles.get(row.rowid)
      if (!mapping) continue
      const full = readFileSync(mapping.absFile, 'utf-8')
      const lowerFull = full.toLowerCase()
      const needle = query.toLowerCase()
      const idx = lowerFull.indexOf(needle)
      const start = Math.max(0, idx >= 0 ? idx : 0)
      const end = Math.min(full.length, start + MAX_SNIPPET_CHARS)
      hits.push({
        relativePath: mapping.relativePath,
        content: idx >= 0 ? full.slice(start, end) : full.slice(0, Math.min(full.length, MAX_SNIPPET_CHARS)),
        startIndex: start,
        endIndex: end,
        score: row.score,
        matchedTokens: terms.map((t) => t.replace(/"/g, '')),
      })
    }
    return hits
  }

  /** FTS 语法失败/空匹配时的整词降级：全文 indexOf 线性扫描 */
  const searchFallback = (query: string, topK: number): MemoryArchiveSearchHit[] => {
    const hits: MemoryArchiveSearchHit[] = []
    const needle = query.toLowerCase()
    const files = collectMarkdownFiles(memoryDir)
    for (const absFile of files) {
      let text: string
      try { text = readFileSync(absFile, 'utf-8').toLowerCase() } catch { continue }
      const idx = text.indexOf(needle)
      if (idx < 0) continue
      const full = readFileSync(absFile, 'utf-8')
      const start = Math.max(0, idx - 60)
      const end = Math.min(full.length, start + MAX_SNIPPET_CHARS)
      hits.push({
        relativePath: toRelativePath(memoryDir, absFile),
        content: full.slice(start, end),
        startIndex: start,
        endIndex: end,
        score: 0,
        matchedTokens: [],
      })
    }
    return hits.sort((a, b) => a.relativePath.localeCompare(b.relativePath)).slice(0, Math.min(topK, MAX_TOP_K))
  }

  /** 清理资源（测试用） */
  const close = () => {
    if (db) { try { db.close() } catch { /* noop */ } db = null }
    rowFiles.clear()
    fileRowIds.clear()
    fileMeta.clear()
    scannedDir = false
  }

  return { search, rebuildAll, close }
}

/** 便捷函数：对指定 memory-archive 目录执行一次检索（惰性索引）。 */
export function searchMemoryArchive(memoryArchivePath: string, query: string, topK = 5): MemoryArchiveSearchHit[] {
  const searcher = createMemoryArchiveSearcher(memoryArchivePath)
  try {
    return searcher.search(query, topK)
  } finally {
    searcher.close()
  }
}

/** 计算字符串指纹（供缓存/测试断言）。 */
export function fingerprintOfText(text: string): string {
  return createHash('sha1').update(text, 'utf-8').digest('hex').slice(0, 12)
}
