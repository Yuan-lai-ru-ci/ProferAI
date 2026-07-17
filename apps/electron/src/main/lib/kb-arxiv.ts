/**
 * arXiv API 客户端
 *
 * 负责搜索 arXiv 论文、下载 PDF，并通过 MinerU 解析。
 * 搜索通过服务端代理（避免 CORS 和限频），下载直接调 arXiv。
 */

import { getFetchFn } from './proxy-fetch'
import { getTeamAuthWithRefresh } from './auth-service'
import { parsePaper } from './paper-service'
import type { ArxivPaper } from '@profer/shared'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query'

/**
 * 解析 arXiv API 返回的 Atom XML
 */
function parseArxivAtom(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = []

  // 用正则提取每个 <entry> 块（避免引入 XML 解析库）
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let entryMatch: RegExpExecArray | null

  while ((entryMatch = entryRe.exec(xml)) !== null) {
    const entry = entryMatch[1]
    if (!entry) continue

    const idMatch = entry.match(/<id>.*?\/([^/]+?)(?:v\d+)?<\/id>/)
    const arxivId = idMatch?.[1]?.trim() || ''

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/)
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || ''

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/)
    const abstract = summaryMatch?.[1]?.replace(/\s+/g, ' ').trim() || ''

    // 提取作者
    const authors: string[] = []
    const authorRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g
    let authorMatch: RegExpExecArray | null
    while ((authorMatch = authorRe.exec(entry)) !== null) {
      authors.push(authorMatch[1]?.trim() || '')
    }

    // 提取年份
    const publishedMatch = entry.match(/<published>(\d{4})-\d{2}-\d{2}/)
    const year = publishedMatch?.[1] ? parseInt(publishedMatch[1], 10) : new Date().getFullYear()

    // 提取分类
    const categoryMatch = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)
    const primaryCategory = categoryMatch?.[1] || ''

    const publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''

    papers.push({
      arxivId,
      title,
      authors,
      abstract,
      year,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      arxivUrl: `https://arxiv.org/abs/${arxivId}`,
      primaryCategory,
      publishedAt,
    })
  }

  return papers
}

/**
 * 搜索 arXiv 论文
 *
 * 优先走服务端代理，fallback 直连 arXiv。
 *
 * @param query 搜索查询
 * @param maxResults 最大返回数（默认 10）
 */
export async function searchArxiv(query: string, maxResults = 10): Promise<ArxivPaper[]> {
  // 尝试服务端代理
  try {
    const auth = await getTeamAuthWithRefresh()
    if (auth) {
      const baseUrl = auth.baseUrl.replace(/\/+$/, '')
      const token = auth.proxyToken || auth.token
      const params = new URLSearchParams({ q: query, max: String(maxResults) })
      const resp = await fetch(`${baseUrl}/v1/services/kb/arxiv-search?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (resp.ok) {
        return (await resp.json()) as ArxivPaper[]
      }
    }
  } catch (err) {
    console.warn('[KB arXiv] 服务端代理不可用，回退直连:', (err as Error).message)
  }

  // Fallback: 直连 arXiv
  // 注意：search_query 格式为 `all:<query>`，冒号不能被编码。
  // 避免 URLSearchParams 双重编码——直接用 encodeURIComponent 处理 query 部分
  const fetchFn = getFetchFn()
  const searchQuery = `all:${encodeURIComponent(query)}`
  const url = `${ARXIV_API_BASE}?search_query=${searchQuery}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`
  const resp = await fetchFn(url, {
    headers: { Accept: 'application/atom+xml' },
    signal: AbortSignal.timeout(15_000),
  })

  if (!resp.ok) {
    throw new Error(`arXiv API 返回 ${resp.status}`)
  }

  const xml = await resp.text()
  return parseArxivAtom(xml)
}

/**
 * 下载 arXiv PDF 并通过 MinerU 解析
 *
 * @param arxivId arXiv ID
 * @returns 解析结果
 */
export async function downloadArxivAndParse(arxivId: string): Promise<{
  markdown: string
  pages: number
  creditsUsed: number
  images?: Array<{ name: string; data: string; mimeType: string }>
}> {
  // 提前检查团队认证（避免下载完 PDF 才发现没登录）
  const auth = await getTeamAuthWithRefresh()
  if (!auth) {
    throw new Error('未登录团队账号，论文导入需要登录 Profer 团队服务')
  }

  const fetchFn = getFetchFn()
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`

  console.log(`[KB arXiv] 下载 PDF: ${pdfUrl}`)
  let resp: Response
  try {
    resp = await fetchFn(pdfUrl, {
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    throw new Error(`arXiv PDF 下载超时或网络错误: ${arxivId}`)
  }

  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(`arXiv 论文不存在 (${arxivId})，请检查 arXiv ID 是否正确`)
    }
    throw new Error(`arXiv PDF 下载失败 (${resp.status}): ${arxivId}`)
  }

  // 保存到临时文件
  const tmpDir = join(tmpdir(), 'profer-kb')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `${arxivId}.pdf`)

  const buffer = Buffer.from(await resp.arrayBuffer())
  writeFileSync(tmpPath, buffer)

  console.log(`[KB arXiv] PDF 下载完成: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)

  try {
    // 通过 MinerU 解析
    const result = await parsePaper(tmpPath)
    return {
      markdown: result.markdown,
      pages: result.pages,
      creditsUsed: result.creditsUsed,
      images: result.images || [],
    }
  } finally {
    // 清理临时文件
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}
