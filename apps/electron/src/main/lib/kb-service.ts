/**
 * 知识库核心服务
 *
 * 负责论文的 CRUD、导入、语义搜索等核心逻辑。
 * 存储结构：
 *   ~/.profer/knowledge-base/
 *   ├── index.json          # 论文元数据索引
 *   └── papers/{id}/
 *       ├── full.md          # MinerU 解析的完整 Markdown
 *       ├── metadata.json    # 元数据
 *       └── chunks.json      # 分块 + embedding 向量
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  getKnowledgeBaseIndexPath,
  getKnowledgeBaseDir,
  getPaperDir,
} from './config-paths'
import { parsePaper } from './paper-service'
import { findEmbeddingChannel, embedTexts, cosineSimilarity } from './kb-embedder'
import { chunkPaper } from './kb-chunker'
import { downloadArxivAndParse } from './kb-arxiv'
import type {
  PaperMeta,
  PaperChunk,
  KBSearchResult,
  KBImportInput,
  KBImportResult,
  KBStats,
} from '@profer/shared'

// ===== 工具函数 =====

function readIndex(): PaperMeta[] {
  const indexPath = getKnowledgeBaseIndexPath()
  if (!existsSync(indexPath)) return []
  try {
    const raw = readFileSync(indexPath, 'utf-8')
    return JSON.parse(raw) as PaperMeta[]
  } catch {
    return []
  }
}

function writeIndex(papers: PaperMeta[]): void {
  const indexPath = getKnowledgeBaseIndexPath()
  writeFileSync(indexPath, JSON.stringify(papers, null, 2), 'utf-8')
}

function readChunks(paperId: string): PaperChunk[] {
  const chunksPath = join(getPaperDir(paperId), 'chunks.json')
  if (!existsSync(chunksPath)) return []
  try {
    const raw = readFileSync(chunksPath, 'utf-8')
    return JSON.parse(raw) as PaperChunk[]
  } catch {
    return []
  }
}

function writeChunks(paperId: string, chunks: PaperChunk[]): void {
  const chunksPath = join(getPaperDir(paperId), 'chunks.json')
  writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), 'utf-8')
}

/**
 * 用规则从 Markdown 提取元数据
 */
function extractMetadata(markdown: string, fileName?: string): { title: string; authors: string[]; abstract: string; year?: number } {
  const lines = markdown.split('\n')
  let title = ''
  const authors: string[] = []
  let abstract = ''
  let year: number | undefined

  // 提取标题（首个 # 开头的行）
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/)
    if (h1 && h1[1]) {
      title = h1[1].trim()
      break
    }
  }
  if (!title && fileName) {
    title = fileName.replace(/\.(pdf|md)$/i, '')
  }

  // 提取作者（"Authors:" 或作者列表行）
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const rawLine = lines[i]
    if (!rawLine) continue
    const line = rawLine.trim()
    const authorMatch = line.match(/^(?:Authors?|By|作者)[:\s]*[:\-—–]\s*(.+)/i)
    if (authorMatch && authorMatch[1]) {
      // 分割作者（逗号、分号、and）
      authors.push(...authorMatch[1].split(/[,;，；]|\band\b/).map((a) => a.trim()).filter(Boolean))
      break
    }
    // 尝试识别纯作者行（逗号分隔的名字列表，出现在标题之后）
    if (i > 0 && i < 10 && line.length > 3 && line.length < 200 &&
        /^[A-Z][a-z]+/.test(line) && line.includes(',')) {
      const parts = line.split(/[,;，；]/)
      if (parts.length >= 2 && parts.every((p) => p.trim().length > 2)) {
        authors.push(...parts.map((a) => a.trim()).filter(Boolean))
        break
      }
    }
  }

  // 提取摘要（Abstract 段）
  const abstractStart = lines.findIndex((l) => /^#*\s*Abstract/i.test(l))
  if (abstractStart >= 0) {
    const absLines: string[] = []
    for (let i = abstractStart + 1; i < Math.min(lines.length, abstractStart + 30); i++) {
      const rawLine = lines[i]
      if (!rawLine) continue
      const line = rawLine.trim()
      // 遇到下一个标题或空行过多就停止
      if (/^#{1,3}\s+/.test(line) && i > abstractStart + 2) break
      absLines.push(line)
    }
    abstract = absLines.join(' ').replace(/\s+/g, ' ').trim()
  }

  // 提取年份
  for (const line of lines.slice(0, 30)) {
    const yearMatch = line.match(/\b(19|20)\d{2}\b/)
    if (yearMatch) {
      const y = parseInt(yearMatch[0], 10)
      if (y >= 1990 && y <= 2030) {
        year = y
        break
      }
    }
  }

  return { title, authors, abstract, year }
}

// ===== 公共 API =====

/**
 * 导入论文到知识库
 *
 * @param input 导入来源（本地文件路径或 arXiv ID）
 * @returns 导入结果
 */
export async function importPaper(input: KBImportInput): Promise<KBImportResult> {
  let markdown: string
  let pages: number
  let creditsUsed: number
  let source: 'local' | 'arxiv'
  let originalFileName: string | undefined
  let arxivId: string | undefined
  let images: Array<{ name: string; data: string; mimeType: string }> | undefined

  if (input.source.type === 'file') {
    // 本地 PDF
    source = 'local'
    const filePath = input.source.filePath
    originalFileName = filePath.split(/[/\\]/).pop()
    const result = await parsePaper(filePath)
    markdown = result.markdown
    pages = result.pages
    creditsUsed = result.creditsUsed
    images = result.images
    // 尝试从文件名提取 arXiv ID
    const arxivMatch = originalFileName?.match(/(\d{4}\.\d{4,5})/)
    if (arxivMatch) arxivId = arxivMatch[1]
  } else if (input.source.type === 'arxiv') {
    // arXiv 导入
    source = 'arxiv'
    arxivId = input.source.arxivId
    // 调用 arXiv 下载 + 解析
    const result = await downloadArxivAndParse(arxivId)
    markdown = result.markdown
    pages = result.pages
    creditsUsed = result.creditsUsed
    images = result.images
    originalFileName = `${arxivId}.pdf`
  } else {
    throw new Error('不支持的导入来源')
  }

  // 保存 Markdown（图片 base64 内嵌，自包含）
  const paperId = randomUUID()
  const paperDir = getPaperDir(paperId)

  let finalMarkdown = markdown

  if (images && images.length > 0) {
    const imagesDir = join(paperDir, 'images')
    mkdirSync(imagesDir, { recursive: true })

    for (const img of images) {
      // 本地保存一份原始图片（备份/导出用）
      const baseName = img.name.split('/').pop() || img.name
      writeFileSync(join(imagesDir, baseName), Buffer.from(img.data, 'base64'))

      // 把 markdown 中引用该图片的相对路径替换为 base64 data URI
      const dataUri = `data:${img.mimeType};base64,${img.data}`
      const escapedPath = img.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

      // 先尝试匹配完整相对路径（如 images/figure_1.png）
      finalMarkdown = finalMarkdown.replace(
        new RegExp(`!\\[([^\\]]*)\\]\\(${escapedPath}\\)`, 'g'),
        `![$1](${dataUri})`,
      )
      // 再尝试仅匹配文件名（如 figure_1.png）
      if (escapedPath !== escapedBase) {
        finalMarkdown = finalMarkdown.replace(
          new RegExp(`!\\[([^\\]]*)\\]\\(${escapedBase}\\)`, 'g'),
          `![$1](${dataUri})`,
        )
      }
    }

    console.log(`[KB] 内嵌了 ${images.length} 张图片到 markdown`)
  }

  writeFileSync(join(paperDir, 'full.md'), finalMarkdown, 'utf-8')

  // 提取元数据
  const metadata = extractMetadata(markdown, originalFileName)
  const doi = extractDoi(markdown)

  // 分块
  const chunksWithoutEmbedding = chunkPaper(markdown, paperId)

  // Embedding
  let chunks: PaperChunk[] = chunksWithoutEmbedding.map((c) => ({ ...c, embedding: undefined }))
  try {
    const channelInfo = findEmbeddingChannel()
    if (channelInfo) {
      const texts = chunksWithoutEmbedding.map((c) => c.content)
      const embeddings = await embedTexts(texts, channelInfo)
      chunks = chunksWithoutEmbedding.map((c, i) => ({
        ...c,
        embedding: embeddings[i] || undefined,
      }))
    } else {
      console.warn('[KB] 未找到可用的 Embedding 渠道，论文将无法语义搜索')
    }
  } catch (err) {
    console.warn('[KB] Embedding 失败，论文仍可被关键词搜索:', (err as Error).message)
  }

  // 持久化
  writeChunks(paperId, chunks)

  // 更新索引
  const paperMeta: PaperMeta = {
    id: paperId,
    title: metadata.title || originalFileName || '未命名论文',
    authors: metadata.authors,
    abstract: metadata.abstract,
    doi,
    arxivId,
    year: metadata.year,
    source,
    pageCount: pages,
    importedAt: Date.now(),
    tags: [],
    chunkCount: chunks.length,
    originalFileName,
  }

  const papers = readIndex()
  papers.unshift(paperMeta)
  writeIndex(papers)

  console.log(`[KB] 导入完成: ${paperMeta.title} (${pages} 页, ${chunks.length} chunks, ${creditsUsed} 积分)`)

  return { paper: paperMeta, creditsUsed, chunkCount: chunks.length }
}

/**
 * 语义搜索论文
 *
 * @param query 查询文本
 * @param topK 返回数量（默认 5）
 * @returns 排序后的搜索结果
 */
export async function searchPapers(query: string, topK = 5): Promise<KBSearchResult[]> {
  const channelInfo = findEmbeddingChannel()
  if (!channelInfo) {
    throw new Error('未找到可用的 Embedding 渠道，无法进行语义搜索。请在设置中配好模型渠道。')
  }

  // 查询 embedding
  const [queryEmbedding] = await embedTexts([query], channelInfo)
  if (!queryEmbedding || queryEmbedding.length === 0) {
    throw new Error('查询 Embedding 为空')
  }

  // 加载所有 chunks 并计算相似度
  const papers = readIndex()
  const allResults: KBSearchResult[] = []

  for (const paper of papers) {
    const chunks = readChunks(paper.id)
    for (const chunk of chunks) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue
      const score = cosineSimilarity(queryEmbedding, chunk.embedding)
      // 不暴露 embedding 到搜索结果
      const { embedding: _, ...cleanChunk } = chunk
      allResults.push({ chunk: cleanChunk as PaperChunk, paper, score })
    }
  }

  // 排序 + 去重（同一论文最多返回 3 个 top chunks）
  allResults.sort((a, b) => b.score - a.score)
  const paperCounts = new Map<string, number>()
  const deduped: KBSearchResult[] = []

  for (const r of allResults) {
    const count = paperCounts.get(r.paper.id) || 0
    if (count >= 3) continue
    paperCounts.set(r.paper.id, count + 1)
    deduped.push(r)
    if (deduped.length >= topK) break
  }

  return deduped
}

/**
 * 列出所有论文
 */
export function listPapers(tag?: string): PaperMeta[] {
  const papers = readIndex()
  if (tag) {
    return papers.filter((p) => p.tags.includes(tag))
  }
  return papers
}

/**
 * 获取单篇论文完整内容
 */
export function getPaper(paperId: string): { meta: PaperMeta; markdown: string } | null {
  const papers = readIndex()
  const paper = papers.find((p) => p.id === paperId)
  if (!paper) return null

  const mdPath = join(getPaperDir(paperId), 'full.md')
  if (!existsSync(mdPath)) return { meta: paper, markdown: '' }

  const markdown = readFileSync(mdPath, 'utf-8')
  return { meta: paper, markdown }
}

/**
 * 删除论文及所有关联数据
 */
export function deletePaper(paperId: string): boolean {
  const papers = readIndex()
  const paper = papers.find((p) => p.id === paperId)
  if (!paper) return false

  // 删除文件
  const paperDir = getPaperDir(paperId)
  try {
    rmSync(paperDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`[KB] 删除论文目录失败: ${paperDir}`, err)
  }

  // 更新索引
  writeIndex(papers.filter((p) => p.id !== paperId))
  return true
}

/**
 * 获取知识库统计
 */
export function getKBStats(): KBStats {
  const papers = readIndex()
  let totalChunks = 0
  let storageBytes = 0

  const kbDir = getKnowledgeBaseDir()
  try {
    const entries = readdirSync(kbDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const stat = statSync(join(kbDir, entry.name))
          storageBytes += stat.size
        } catch { /* skip */ }
      }
    }

    const papersDir = join(kbDir, 'papers')
    if (existsSync(papersDir)) {
      const paperDirs = readdirSync(papersDir, { withFileTypes: true })
      for (const dir of paperDirs) {
        if (!dir.isDirectory()) continue
        try {
          const files = readdirSync(join(papersDir, dir.name))
          for (const f of files) {
            try {
              const stat = statSync(join(papersDir, dir.name, f))
              storageBytes += stat.size
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  for (const p of papers) {
    totalChunks += p.chunkCount
  }

  return {
    totalPapers: papers.length,
    totalChunks,
    storageBytes,
  }
}

// ===== 辅助函数 =====

function extractDoi(markdown: string): string | undefined {
  const doiMatch = markdown.match(/\b10\.\d{4,}\/[\w./-]+\b/)
  return doiMatch ? doiMatch[0] : undefined
}
