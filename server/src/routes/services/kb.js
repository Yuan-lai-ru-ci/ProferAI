/**
 * 知识库服务代理路由
 *
 * 代理 arXiv API 调用，解决客户端 CORS 和限频问题。
 * 同时提供 arXiv PDF 下载 + MinerU 解析的一站式端点。
 */

import { Hono } from 'hono'

export const kbRoutes = new Hono()

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query'

/**
 * 解析 arXiv Atom XML 为 JSON
 */
function parseArxivAtom(xml) {
  const papers = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let entryMatch

  while ((entryMatch = entryRe.exec(xml)) !== null) {
    const entry = entryMatch[1]

    const idMatch = entry.match(/<id>.*?\/([^/]+?)(?:v\d+)?<\/id>/)
    const arxivId = idMatch?.[1]?.trim() || ''

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/)
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() || ''

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/)
    const abstract = summaryMatch?.[1]?.replace(/\s+/g, ' ').trim() || ''

    const authors = []
    const authorRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g
    let authorMatch
    while ((authorMatch = authorRe.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim())
    }

    const publishedMatch = entry.match(/<published>(\d{4})-\d{2}-\d{2}/)
    const year = publishedMatch ? parseInt(publishedMatch[1], 10) : new Date().getFullYear()

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
 * GET /v1/services/kb/arxiv-search?q=...&max=10
 *
 * 搜索 arXiv 论文，返回格式化的 JSON 列表
 */
kbRoutes.get('/arxiv-search', async (c) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json({ error: '未提供认证令牌' }, 401)
  }

  const q = c.req.query('q')
  const max = parseInt(c.req.query('max') || '10', 10)

  if (!q || q.trim().length === 0) {
    return c.json({ error: '搜索关键词不能为空' }, 400)
  }

  // 注意：search_query 格式为 `all:<query>`，冒号不能被编码。
  // 避免 URLSearchParams 双重编码——直接用 encodeURIComponent 处理 query 部分
  const searchQuery = `all:${encodeURIComponent(q.trim())}`
  const params = new URLSearchParams({
    start: '0',
    max_results: String(Math.min(max, 20)),
    sortBy: 'relevance',
    sortOrder: 'descending',
  })

  try {
    const resp = await fetch(`${ARXIV_API_BASE}?search_query=${searchQuery}&${params.toString()}`, {
      headers: { Accept: 'application/atom+xml' },
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) {
      console.error(`[kb] arXiv 搜索失败: ${resp.status}`)
      return c.json({ error: `arXiv API 返回 ${resp.status}` }, 502)
    }

    const xml = await resp.text()
    const papers = parseArxivAtom(xml)
    return c.json(papers)
  } catch (err) {
    console.error('[kb] arXiv 搜索异常:', err.message)
    return c.json({ error: 'arXiv 搜索失败', message: err.message }, 502)
  }
})
