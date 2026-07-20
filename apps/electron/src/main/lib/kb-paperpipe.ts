/**
 * 论文知识库 — paperpipe 服务端代理
 *
 * 将论文管理操作代理到 Profer Team Server 上的 paperpipe 服务。
 * 替代 kb-service.ts 的核心 CRUD + 搜索逻辑。
 *
 * 混合方案：
 *   - arXiv 论文 → paperpipe 服务端（LaTeX 源码 + LEANN 索引）
 *   - 本地 PDF → MinerU 解析（高质量 Markdown）→ PDF 上传 paperpipe
 *   - 搜索 → paperpipe 内置搜索（grep → BM25 → LEANN）
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getKnowledgeBaseDir, getPaperDir, resolvePaperDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getTeamAuthWithRefresh } from './auth-service'
import { parsePaper } from './paper-service'
import { findPaperMatch, mergePaperMeta, remotePaperToMeta, resolveRemoteSource, selectRemoteMarkdown } from './kb-paperpipe-mapping'
import { isRetryablePaperpipeSyncError } from './kb-paperpipe-retry-utils'
import type {
  KBLibrarySnapshot,
  PaperMeta,
  KBSearchResult,
  KBImportInput,
  KBImportResult,
  KBStats,
  PaperChunk,
  DeletePaperResult,
} from '@profer/shared'

// ===== 旧的本地索引（向后兼容） =====

function readLocalIndex(): PaperMeta[] {
  const indexPath = join(getKnowledgeBaseDir(), 'index.json')
  if (!existsSync(indexPath)) return []
  const parsed = readJsonFileSafe<unknown>(indexPath)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((paper): paper is PaperMeta => (
    !!paper && typeof paper === 'object' && typeof (paper as PaperMeta).id === 'string'
  ))
}

// ===== API 调用辅助 =====

interface PaperpipePaper {
  id: string
  title: string
  authors: string[]
  abstract?: string
  year?: number
  tags: string[]
  arxivId?: string
  arxiv_id?: string  // paperpipe 原生格式（bridge 已标准化为 arxivId）
  categories?: string[]
  added?: string
  source?: 'arxiv' | 'local'
}

type UploadState = { token: string; deleted: boolean }
const uploadTokens = new Map<string, UploadState>()

function beginUpload(paperId: string): string {
  const token = randomUUID()
  uploadTokens.set(paperId, { token, deleted: false })
  return token
}

function isCurrentUpload(paperId: string, token: string): boolean {
  const state = uploadTokens.get(paperId)
  return state?.token === token && !state.deleted && readLocalIndex().some((paper) => paper.id === paperId)
}

function markUploadDeleted(paperId: string): boolean {
  const state = uploadTokens.get(paperId)
  if (!state) return false
  state.deleted = true
  return true
}

function endUpload(paperId: string, token: string): void {
  if (uploadTokens.get(paperId)?.token === token) uploadTokens.delete(paperId)
}

async function removeOrphanedRemotePaper(remoteId: string): Promise<void> {
  try {
    await paperpipeApi(`/remove/${encodeURIComponent(remoteId)}`, { method: 'DELETE' })
  } catch (error) {
    // 本地索引已被删除；保留明确日志，后续可由 Bridge 运维清理，而不能重新写回已删除论文。
    console.warn('[KB] 清理删除期间创建的远端论文失败:', (error as Error).message)
  }
}

async function paperpipeApi<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const auth = await getTeamAuthWithRefresh()
  if (!auth) {
    throw new Error('未登录团队账号，论文知识库需要登录 Profer 团队服务')
  }

  const baseUrl = auth.baseUrl.replace(/\/+$/, '')
  const token = auth.proxyToken || auth.token
  const method = options.method || 'GET'
  const timeout = options.timeout || 120_000

  const fetchOpts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeout),
  }

  if (options.body && method !== 'GET') {
    fetchOpts.body = JSON.stringify(options.body)
  }

  const resp = await fetch(`${baseUrl}/v1/services/paperpipe${path}`, fetchOpts)

  if (resp.status === 401) {
    throw new Error('登录已过期，请重新登录团队账号')
  }

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    const error = new Error(data.message || data.error || `服务端错误 (${resp.status})`) as Error & { status?: number; code?: string }
    error.status = resp.status
    error.code = typeof data.code === 'string' ? data.code : undefined
    throw error
  }

  return resp.json() as Promise<T>
}

// ===== 公共 API =====

/**
 * 导入论文到论文知识库
 *
 * arXiv：走 paperpipe 服务端
 * 本地 PDF：MinerU 解析 → 保存 Markdown 本地 → 上传 PDF 到 paperpipe
 */
export async function importPaper(input: KBImportInput): Promise<KBImportResult> {
  if (input.source.type === 'arxiv') {
    // arXiv → paperpipe 服务端
    const arxivId = input.source.arxivId
    const result = await paperpipeApi<{
      success: boolean
      paper: PaperpipePaper
    }>('/add', {
      method: 'POST',
      body: { arxivId },
      timeout: 300_000,
    })

    const paperMeta: PaperMeta = {
      id: result.paper.id,
      title: result.paper.title,
      authors: result.paper.authors,
      abstract: '',
      arxivId: result.paper.arxivId || arxivId,
      year: result.paper.year,
      source: 'arxiv',
      pageCount: 0,
      importedAt: Date.now(),
      tags: result.paper.tags || [],
      chunkCount: 0,
      remoteId: result.paper.id,
      syncState: 'synced',
    }

    // 同步更新本地索引
    syncLocalIndex(paperMeta)

    return { paper: paperMeta, creditsUsed: 0, chunkCount: 0 }
  }

  if (input.source.type === 'file') {
    // 本地 PDF → MinerU 解析 → 保存本地 → 上传 paperpipe
    const filePath = input.source.filePath
    const parseResult = await parsePaper(filePath)

    const paperId = randomUUID()
    const paperDir = getPaperDir(paperId)
    const originalFileName = filePath.split(/[/\\]/).pop()

    // 保存受控本地副本，未来 Bridge 具备幂等契约后才能安全重试；绝不持久化用户绝对路径。
    copyFileSync(filePath, join(paperDir, 'original.pdf'))
    writeFileSync(join(paperDir, 'full.md'), parseResult.markdown, 'utf-8')

    // 提取元数据
    const metadata = extractBasicMetadata(parseResult.markdown, originalFileName)

    const paperMeta: PaperMeta = {
      id: paperId,
      title: metadata.title || originalFileName || '未命名论文',
      authors: metadata.authors,
      abstract: metadata.abstract,
      year: metadata.year,
      source: 'local',
      pageCount: parseResult.pages,
      importedAt: Date.now(),
      tags: [],
      chunkCount: 0,
      originalFileName,
    }

    // 上传完成前明确标为待同步，避免本地成功被误认为远端已建立。
    paperMeta.syncState = 'pending'
    paperMeta.lastSyncAttemptAt = Date.now()
    syncLocalIndex(paperMeta)
    const uploadToken = beginUpload(paperId)
    uploadPdfToPaperpipe(join(paperDir, 'original.pdf'), paperId)
      .then(async (remoteId) => {
        if (isCurrentUpload(paperId, uploadToken)) {
          syncLocalIndex({ id: paperId, remoteId, syncState: 'synced', syncError: undefined, lastSyncAttemptAt: Date.now() })
        } else {
          await removeOrphanedRemotePaper(remoteId)
        }
      })
      .catch((err) => {
        console.warn('[KB] paperpipe 上传 PDF 失败（论文已保存本地）:', (err as Error).message)
        if (isCurrentUpload(paperId, uploadToken)) {
          syncLocalIndex({ id: paperId, syncState: 'failed', syncError: '远端同步失败，已保留本地内容', lastSyncAttemptAt: Date.now() })
        }
      })
      .finally(() => endUpload(paperId, uploadToken))

    return { paper: paperMeta, creditsUsed: parseResult.creditsUsed, chunkCount: 0 }
  }

  throw new Error('不支持的导入来源')
}

/** 异步上传 PDF 到 paperpipe 服务端 */
async function uploadPdfToPaperpipe(filePath: string, clientPaperId: string): Promise<string> {
  const auth = await getTeamAuthWithRefresh()
  if (!auth) throw new Error('未登录团队账号')

  const baseUrl = auth.baseUrl.replace(/\/+$/, '')
  const token = auth.proxyToken || auth.token

  const fileBuffer = readFileSync(filePath)
  const fileName = filePath.split(/[/\\]/).pop() || 'paper.pdf'

  // 手动构建 multipart/form-data（Electron 主进程无 Blob/FormData）
  const boundary = `----Paperpipe${Date.now()}${Math.random().toString(36).slice(2)}`
  const crlf = '\r\n'

  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    `Content-Type: application/pdf`,
    '',
    '',
  ].join(crlf)

  const footer = `${crlf}--${boundary}--${crlf}`
  const headerBuffer = Buffer.from(header, 'utf-8')
  const footerBuffer = Buffer.from(footer, 'utf-8')
  const body = Buffer.concat([headerBuffer, fileBuffer, footerBuffer])

  const resp = await fetch(`${baseUrl}/v1/services/paperpipe/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
      'X-Client-Paper-Id': clientPaperId,
    },
    body,
    signal: AbortSignal.timeout(300_000),
  })

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}))
    const error = new Error(errData.message || errData.error || `上传失败 (${resp.status})`) as Error & { status?: number; code?: string }
    error.status = resp.status
    error.code = typeof errData.code === 'string' ? errData.code : undefined
    throw error
  }
  const data = await resp.json().catch(() => ({})) as { remoteId?: unknown; paper?: { id?: unknown }; id?: unknown }
  const remoteId = data.remoteId ?? data.paper?.id ?? data.id
  if (typeof remoteId !== 'string' || !remoteId.trim()) throw new Error('服务端未返回远端论文标识')
  return remoteId
}

/** 从本机受控副本显式重试失败的本地 PDF 同步。 */
export async function retryPaperpipeSync(paperId: string): Promise<PaperMeta> {
  const paper = readLocalIndex().find((item) => item.id === paperId)
  if (!paper || paper.source !== 'local') throw new Error('仅本地 PDF 支持重新同步')
  if (paper.remoteId || paper.syncState === 'synced') throw new Error('论文已完成远端同步')
  if (paper.syncState !== 'pending' && paper.syncState !== 'failed') throw new Error('论文当前无需重新同步')

  const originalPdf = join(resolvePaperDir(paperId), 'original.pdf')
  if (!existsSync(originalPdf)) throw new Error('本地 PDF 副本不存在，无法重新同步')
  if (uploadTokens.has(paperId)) throw new Error('该论文正在同步，请稍候')

  const token = beginUpload(paperId)
  syncLocalIndex({ id: paperId, syncState: 'pending', syncError: undefined, lastSyncAttemptAt: Date.now() })
  try {
    const remoteId = await uploadPdfToPaperpipe(originalPdf, paperId)
    if (!isCurrentUpload(paperId, token)) {
      await removeOrphanedRemotePaper(remoteId)
      throw new Error('同步已取消或论文已删除')
    }
    const updated = { ...paper, remoteId, syncState: 'synced' as const, syncError: undefined, lastSyncAttemptAt: Date.now() }
    syncLocalIndex(updated)
    return updated
  } catch (error) {
    if (isCurrentUpload(paperId, token)) {
      const reason = isRetryablePaperpipeSyncError(error) ? '远端暂不可用，可稍后重新同步' : '远端拒绝上传，请检查 PDF、大小或登录状态'
      syncLocalIndex({ id: paperId, syncState: 'failed', syncError: reason, lastSyncAttemptAt: Date.now() })
    }
    throw error
  } finally {
    endUpload(paperId, token)
  }
}

/**
 * 搜索论文（优先 paperpipe 服务端，fallback 本地关键词）
 *
 * @param query 搜索查询
 * @param topK 返回数量
 * @param mode 搜索模式: "fts" (FTS5 关键词), "semantic" (bge-small 语义), "hybrid" (FTS5 + 语义重排，默认)
 */
export async function searchPapers(query: string, topK = 5, mode: 'fts' | 'semantic' | 'hybrid' = 'hybrid'): Promise<KBSearchResult[]> {
  // 优先用 paperpipe 服务端搜索
  try {
    const result = await paperpipeApi<{
      results: Array<{
        paperId: string
        score: number
        snippet: string
        title: string
        authors: string[]
        abstract: string
        year?: number
        tags: string[]
        arxivId?: string
        source?: 'arxiv' | 'local'
      }>
    }>('/search', { method: 'POST', body: { query, topK, mode } })

    if (result.results && result.results.length > 0) {
      return result.results.slice(0, topK).map((r) => ({
        chunk: {
          id: '',
          paperId: r.paperId,
          content: r.snippet,
          sectionTitle: '',
          startIndex: 0,
          endIndex: r.snippet.length,
        },
        paper: {
          id: r.paperId,
          title: r.title || r.paperId,
          authors: r.authors || [],
          abstract: r.abstract || '',
          source: resolveRemoteSource(r.source) ?? 'arxiv',
          pageCount: 0,
          importedAt: Date.now(),
          tags: r.tags || [],
          chunkCount: 0,
          arxivId: r.arxivId,
          year: r.year,
        },
        score: r.score,
      }))
    }
  } catch (err) {
    console.warn('[KB] paperpipe 搜索失败，回退本地:', (err as Error).message)
  }

  // Fallback：本地关键词搜索
  return localKeywordSearch(query, topK)
}

/**
 * 列出所有论文（paperpipe 服务端 + 本地合并）
 */
export async function loadLibrarySnapshot(): Promise<KBLibrarySnapshot> {
  const papers = readLocalIndex()
  try {
    const result = await paperpipeApi<{ papers: PaperpipePaper[] }>('/list')
    for (const remote of result.papers) {
      const incoming = remotePaperToMeta(remote)
      const existingIndex = findPaperMatch(papers, incoming)
      const merged = mergePaperMeta(existingIndex >= 0 ? papers[existingIndex] : undefined, incoming)
      if (existingIndex >= 0) papers[existingIndex] = merged
      else papers.unshift(merged)
    }
    writeJsonFileAtomic(join(getKnowledgeBaseDir(), 'index.json'), papers)
    return { papers, stats: computeKBStats(papers), remoteState: 'synced' }
  } catch (err) {
    console.warn('[KB] paperpipe list 失败，仅显示本地论文:', (err as Error).message)
    return { papers, stats: computeKBStats(papers), remoteState: 'degraded', remoteError: '远端暂不可用，当前显示本地缓存' }
  }
}

export async function listPapers(tag?: string): Promise<PaperMeta[]> {
  const { papers } = await loadLibrarySnapshot()
  return tag ? papers.filter((paper) => paper.tags.includes(tag)) : papers
}

/**
 * 获取单篇论文完整内容（本地优先，fallback paperpipe 服务端）
 */
export async function getPaper(paperId: string): Promise<{ meta: PaperMeta; markdown: string } | null> {
  // 先检查本地
  const localPapers = readLocalIndex()
  const localPaper = localPapers.find((p) => p.id === paperId)
  if (localPaper) {
    if (localPaper.source === 'local') {
      const mdPath = join(resolvePaperDir(paperId), 'full.md')
      try {
        const markdown = readFileSync(mdPath, 'utf-8')
        if (markdown) return { meta: localPaper, markdown }
      } catch { /* ignore */ }
    }
    // 本地有记录但无内容 → fallback 服务端（arXiv 论文内容在服务端）
    const remoteId = localPaper.remoteId ?? (localPaper.source === 'arxiv' ? localPaper.id : undefined)
    if (remoteId) {
      const serverResult = await getPaperAsync(remoteId)
      if (serverResult) return { meta: localPaper, markdown: serverResult.markdown }
    }
    return { meta: localPaper, markdown: '' }
  }

  // paperpipe 论文 → 从服务端获取
  return getPaperAsync(paperId)
}

/**
 * 异步从 paperpipe 获取论文内容
 */
export async function getPaperAsync(paperId: string): Promise<{ meta: PaperMeta; markdown: string } | null> {
  try {
    const result = await paperpipeApi<{
      id: string
      title: string
      authors: string[]
      year?: number
      tags: string[]
      arxivId?: string
      summary?: string
      equations?: string
      tldr?: string
      markdown?: string
      source?: 'arxiv' | 'local'
    }>(`/show/${encodeURIComponent(paperId)}`)

    const combinedMarkdown = selectRemoteMarkdown(result)

    return {
      meta: {
        id: result.id,
        title: result.title,
        authors: result.authors,
        abstract: result.tldr || '',
        arxivId: result.arxivId,
        year: result.year,
        source: resolveRemoteSource(result.source) ?? 'arxiv',
        pageCount: 0,
        importedAt: Date.now(),
        tags: result.tags || [],
        chunkCount: 0,
      },
      markdown: combinedMarkdown,
    }
  } catch {
    return null
  }
}

/**
 * 删除论文
 */
export async function deletePaper(paperId: string): Promise<DeletePaperResult> {
  const localPapers = readLocalIndex()
  const localPaper = localPapers.find((p) => p.id === paperId)
  if (!localPaper) throw new Error('论文不存在')

  const uploadWasPending = markUploadDeleted(paperId)
  const remoteId = localPaper.remoteId ?? (localPaper.source === 'arxiv' ? localPaper.id : undefined)
  if (remoteId) {
    try {
      await paperpipeApi(`/remove/${encodeURIComponent(remoteId)}`, { method: 'DELETE' })
    } catch (error) {
      const status = (error as { status?: unknown })?.status
      if (status !== 404) return { paperId, localDeleted: false, remoteDeleted: false, remoteStatus: 'failed', message: '远端删除失败，本地内容已保留' }
    }
  }
  if (localPaper.source === 'local') rmSync(resolvePaperDir(paperId), { recursive: true, force: true })
  syncLocalIndex(null, paperId)
  return { paperId, localDeleted: true, remoteDeleted: Boolean(remoteId), remoteStatus: remoteId ? 'deleted' : uploadWasPending ? 'pending-cleanup' : 'not-linked' }
}

/**
 * 获取论文知识库统计
 */
function computeKBStats(papers: PaperMeta[]): KBStats {
  return {
    totalPapers: papers.length,
    totalChunks: papers.reduce((sum, paper) => sum + paper.chunkCount, 0),
    storageBytes: 0, // 远端占用不可验证，不伪造全库统计。
  }
}

export async function getKBStats(): Promise<KBStats> {
  return (await loadLibrarySnapshot()).stats
}

// ===== 辅助函数 =====

function syncLocalIndex(newPaper?: Partial<PaperMeta> | null, removeId?: string): void {
  const papers = readLocalIndex()

  if (removeId) {
    writeJsonFileAtomic(join(getKnowledgeBaseDir(), 'index.json'), papers.filter((paper) => paper.id !== removeId))
    return
  }

  if (!newPaper?.id) return
  const existing = papers.findIndex((paper) => paper.id === newPaper.id)
  if (existing >= 0) {
    papers[existing] = { ...papers[existing], ...(newPaper as Omit<PaperMeta, 'id'>), id: newPaper.id }
  } else {
    const complete = newPaper as PaperMeta
    if (typeof complete.title !== 'string' || !complete.source) throw new Error('论文索引记录不完整')
    const match = findPaperMatch(papers, complete)
    if (match >= 0) papers[match] = mergePaperMeta(papers[match], complete)
    else papers.unshift(complete)
  }
  writeJsonFileAtomic(join(getKnowledgeBaseDir(), 'index.json'), papers)
}

function extractBasicMetadata(markdown: string, fileName?: string): {
  title: string
  authors: string[]
  abstract: string
  year?: number
} {
  const lines = markdown.split('\n')
  let title = ''
  const authors: string[] = []
  let abstract = ''
  let year: number | undefined

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/)
    if (h1 && h1[1]) { title = h1[1].trim(); break }
  }
  if (!title && fileName) title = fileName.replace(/\.pdf$/i, '')

  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = (lines[i] || '').trim()
    if (!line) continue
    const authorMatch = line.match(/^(?:Authors?|By|作者)[:\s]*[:\-—–]\s*(.+)/i)
    if (authorMatch && authorMatch[1]) {
      authors.push(...authorMatch[1].split(/[,;，；]|\band\b/).map((a) => a.trim()).filter(Boolean))
      break
    }
  }

  const absStart = lines.findIndex((l) => /^#*\s*Abstract/i.test(l))
  if (absStart >= 0) {
    const absLines: string[] = []
    for (let i = absStart + 1; i < Math.min(lines.length, absStart + 30); i++) {
      const line = (lines[i] || '').trim()
      if (!line) continue
      if (/^#{1,3}\s+/.test(line) && i > absStart + 2) break
      absLines.push(line)
    }
    abstract = absLines.join(' ').replace(/\s+/g, ' ').trim()
  }

  for (const line of lines.slice(0, 30)) {
    const y = line.match(/\b(19|20)\d{2}\b/)
    if (y) { year = parseInt(y[0], 10); break }
  }

  return { title, authors, abstract, year }
}

function localKeywordSearch(query: string, topK: number): KBSearchResult[] {
  const papers = readLocalIndex()
  const results: KBSearchResult[] = []
  const queryLower = query.toLowerCase()

  for (const paper of papers) {
    // 标题/作者/摘要匹配
    const titleScore = paper.title.toLowerCase().includes(queryLower) ? 0.5 : 0
    const authorScore = paper.authors.some((a) => a.toLowerCase().includes(queryLower)) ? 0.3 : 0
    const abstractScore = paper.abstract?.toLowerCase().includes(queryLower) ? 0.4 : 0
    const maxScore = Math.max(titleScore, authorScore, abstractScore)

    if (maxScore > 0) {
      results.push({
        chunk: {
          id: '',
          paperId: paper.id,
          content: paper.abstract || paper.title,
          sectionTitle: '',
          startIndex: 0,
          endIndex: paper.abstract?.length || 0,
        } as PaperChunk,
        paper,
        score: maxScore,
      })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topK)
}
