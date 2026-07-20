#!/usr/bin/env node
/**
 * 仅供已授权的生产同构环境手动验收 Paperpipe。
 * 不写死凭据；必须显式提供测试账号 token 与测试 arXiv ID。
 *
 * 示例：
 * PROFER_API_URL=https://example.com/proma \
 * PROFER_TEST_TOKEN=... PAPERPIPE_TEST_ARXIV_ID=2306.05427 \
 * node server/scripts/paperpipe-e2e.mjs
 */

const baseUrl = process.env.PROFER_API_URL?.replace(/\/+$/, '')
const token = process.env.PROFER_TEST_TOKEN?.trim()
const arxivId = process.env.PAPERPIPE_TEST_ARXIV_ID?.trim()

if (!baseUrl || !token || !arxivId) {
  console.error('需要 PROFER_API_URL、PROFER_TEST_TOKEN 与 PAPERPIPE_TEST_ARXIV_ID；拒绝在未明确指定测试账户时执行。')
  process.exit(2)
}

const headers = { Authorization: `Bearer ${token}` }
let paperId

async function request(step, path, options = {}) {
  const response = await fetch(`${baseUrl}/v1/services/paperpipe${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${step} 失败：HTTP ${response.status} ${JSON.stringify(body)}`)
  }
  console.log(`✓ ${step}`)
  return body
}

try {
  await request('Bridge health', '/health')
  const added = await request('arXiv add', '/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arxivId }),
  })
  paperId = added.remoteId ?? added.paper?.id ?? added.id
  if (typeof paperId !== 'string' || !paperId) throw new Error('add 响应没有安全的论文 ID')

  const listed = await request('list', '/list')
  const papers = Array.isArray(listed.papers) ? listed.papers : []
  if (!papers.some((paper) => paper?.id === paperId)) throw new Error(`list 未返回刚创建的论文 ${paperId}`)

  await request('search', '/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: arxivId, topK: 5, mode: 'fts' }),
  })
  await request('show', `/show/${encodeURIComponent(paperId)}`)
  await request('remove', `/remove/${encodeURIComponent(paperId)}`, { method: 'DELETE' })
  paperId = undefined
  console.log('Paperpipe arXiv E2E 完成。PDF 上传、并发和故障注入请按运维文档另行执行。')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (paperId) console.error(`可能需要人工清理的测试论文 ID：${paperId}`)
  process.exitCode = 1
}
