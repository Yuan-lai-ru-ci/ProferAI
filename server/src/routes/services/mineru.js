/**
 * MinerU 论文解析代理路由
 *
 * 使用 MinerU v4 精准解析 API（批量上传模式）：
 *   1. 申请签名上传 URL（POST /api/v4/file-urls/batch）
 *   2. PUT 上传 PDF 到 OSS
 *   3. 轮询批量结果（GET /api/v4/extract-results/batch/{batch_id}）
 *   4. 下载 zip → 提取 full.md → 返回 Markdown
 *
 * MinerU API key 服务端代管，绝不暴露给客户端。
 *
 * 定价：每 10 页 2 积分，最少 1 积分。
 */

import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { deductCredits } from '../../db.js'
import { MINERU_API_KEY, MINERU_CREDITS_PER_10_PAGES } from '../../config.js'
import AdmZip from 'adm-zip'

export const mineruRoutes = new Hono()

/** MinerU v4 API 基地址 */
const MINERU_V4_BASE = 'https://mineru.net/api/v4'

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 3000
/** 轮询超时（毫秒） */
const POLL_TIMEOUT_MS = 300_000 // 5 分钟

/**
 * 从 PDF Buffer 估算页数
 */
function estimatePdfPages(buffer) {
  try {
    const content = buffer.toString('latin1')
    const re = /\/Type\s*\/Page\b/g
    const matches = content.match(re)
    return matches ? matches.length : 1
  } catch {
    return 1
  }
}

/** 计算论文解析的积分消耗 */
function calcPaperCredits(pages) {
  return Math.max(1, Math.ceil(pages / 10) * MINERU_CREDITS_PER_10_PAGES)
}

/**
 * 调 MinerU v4 批量上传：申请上传 URL
 * @returns {{ batch_id: string, file_urls: string[] }}
 */
async function requestUploadUrls(fileName) {
  const resp = await fetch(`${MINERU_V4_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MINERU_API_KEY}`,
    },
    body: JSON.stringify({
      files: [{ name: fileName, is_ocr: true }],
      model_version: 'vlm',
      enable_table: true,
      enable_formula: true,
      language: 'ch',
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`MinerU 上传申请失败 (${resp.status}): ${text.slice(0, 200)}`)
  }

  const result = await resp.json()
  if (result.code !== 0 || !result.data?.batch_id || !result.data?.file_urls?.length) {
    throw new Error(`MinerU 上传申请异常: ${JSON.stringify(result).slice(0, 200)}`)
  }

  return result.data
}

/**
 * PUT 上传文件到 OSS 签名 URL
 */
async function uploadToOss(fileUrl, fileBuffer) {
  const resp = await fetch(fileUrl, {
    method: 'PUT',
    body: fileBuffer,
    signal: AbortSignal.timeout(60_000),
  })

  if (resp.status < 200 || resp.status > 299) {
    const text = await resp.text().catch(() => '')
    throw new Error(`OSS 上传失败 (${resp.status}): ${text.slice(0, 200)}`)
  }
}

/**
 * 轮询批量解析结果直到完成或失败
 * @returns {{ markdown: string, state: string }}
 */
async function pollBatchResult(batchId, includeStructuredJson = false) {
  const startTime = Date.now()

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    const resp = await fetch(`${MINERU_V4_BASE}/extract-results/batch/${batchId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${MINERU_API_KEY}`,
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) {
      throw new Error(`MinerU 结果查询失败 (${resp.status})`)
    }

    const result = await resp.json()
    if (result.code !== 0) {
      throw new Error(`MinerU 结果查询异常: ${result.msg || '未知错误'}`)
    }

    const extractResults = result.data?.extract_result
    if (!extractResults || extractResults.length === 0) {
      throw new Error('MinerU 未返回解析结果')
    }

    const fileResult = extractResults[0]
    const { state, err_msg, full_zip_url } = fileResult

    if (state === 'done') {
      const content = await downloadAndExtractContent(full_zip_url, includeStructuredJson)
      return { ...content, state: 'done' }
    }

    if (state === 'failed') {
      const errMsg = err_msg || '未知错误'
      throw new Error(`MinerU 解析失败: ${errMsg}`)
    }

    console.log(`[mineru] 状态: ${state}，${Math.round((Date.now() - startTime) / 1000)}s 后重试...`)
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`MinerU 解析超时 (${POLL_TIMEOUT_MS / 1000}s)，请稍后重试`)
}

/**
 * 下载 zip 并提取内容
 *
 * @param {string} zipUrl
 * @param {boolean} includeStructuredJson 是否同时提取 content_list.json 等结构化数据
 * @returns {{ markdown: string, contentList?: object, metadata?: object }}
 */
async function downloadAndExtractContent(zipUrl, includeStructuredJson = false) {
  const resp = await fetch(zipUrl, {
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) {
    throw new Error(`下载解析结果失败 (${resp.status})`)
  }

  const zipBuffer = Buffer.from(await resp.arrayBuffer())
  const zip = new AdmZip(zipBuffer)

  // full.md 是 Markdown 解析结果的主文件
  const entry = zip.getEntry('full.md')
  let markdown
  if (!entry) {
    // 尝试列出 zip 内容找 .md 文件
    const entries = zip.getEntries()
    const mdEntry = entries.find((e) => e.entryName.endsWith('.md'))
    if (!mdEntry) {
      throw new Error('解析结果 zip 中未找到 Markdown 文件')
    }
    markdown = mdEntry.getData().toString('utf-8')
  } else {
    markdown = entry.getData().toString('utf-8')
  }

  const result = { markdown }

  // 可选：提取结构化 JSON
  if (includeStructuredJson) {
    try {
      const contentListEntry = zip.getEntries().find(
        (e) => e.entryName.endsWith('content_list.json')
      )
      if (contentListEntry) {
        result.contentList = JSON.parse(contentListEntry.getData().toString('utf-8'))
      }
    } catch (err) {
      console.warn('[mineru] content_list.json 提取失败:', err.message)
    }

    // 提取中间 JSON（含阅读顺序、布局等元信息）
    try {
      const modelEntry = zip.getEntries().find(
        (e) => e.entryName.endsWith('model.json') || e.entryName.endsWith('middle.json')
      )
      if (modelEntry) {
        result.metadata = JSON.parse(modelEntry.getData().toString('utf-8'))
      }
    } catch (err) {
      console.warn('[mineru] model/middle.json 提取失败:', err.message)
    }
  }

  return result
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POST /v1/services/mineru/parse
 *
 * 接收 PDF 文件 → MinerU v4 批量上传解析 → 返回 Markdown
 */
mineruRoutes.post('/parse', async (c) => {
  const userId = c.get('userId')
  if (!userId) {
    return c.json({ error: '未提供认证令牌' }, 401)
  }

  if (!MINERU_API_KEY) {
    console.error('[mineru] MINERU_API_KEY 未配置')
    return c.json({ error: '论文解析服务暂未配置，请联系管理员' }, 503)
  }

  // ---- Content-Length 预检（快速拒绝超大文件，避免 parseBody 全量读入内存） ----
  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10)
  const MINERU_MAX_BYTES = 200 * 1024 * 1024
  if (contentLength > MINERU_MAX_BYTES) {
    return c.json({ error: `文件超过 ${MINERU_MAX_BYTES / 1024 / 1024}MB 上限` }, 413)
  }

  // ---- 接收上传文件 ----
  let fileBuffer
  let fileName
  let formData
  try {
    formData = await c.req.parseBody()
    const file = formData.file
    if (!file) {
      return c.json({ error: '请上传 PDF 文件' }, 400)
    }

    if (file instanceof File) {
      fileName = file.name
      fileBuffer = Buffer.from(await file.arrayBuffer())
    } else if (file && typeof file === 'object') {
      fileName = file.name || 'unknown.pdf'
      if (file.data) {
        fileBuffer = Buffer.from(file.data)
      } else if (typeof file.stream === 'function') {
        const chunks = []
        const reader = file.stream().getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        fileBuffer = Buffer.concat(chunks)
      } else {
        return c.json({ error: '无法读取上传文件' }, 400)
      }
    } else {
      return c.json({ error: '不支持的文件格式' }, 400)
    }
  } catch (err) {
    console.error('[mineru] 文件解析失败:', err.message)
    return c.json({ error: '文件上传解析失败' }, 400)
  }

  // ---- 校验文件 ----
  const ext = (fileName || '').toLowerCase()
  if (!ext.endsWith('.pdf')) {
    return c.json({ error: '仅支持 PDF 文件' }, 400)
  }
  if (fileBuffer.length === 0) {
    return c.json({ error: '文件为空' }, 400)
  }
  if (fileBuffer.length > 200 * 1024 * 1024) {
    return c.json({ error: '文件超过 200MB 上限' }, 413)
  }

  // ---- 估算页数并扣积分 ----
  const pages = estimatePdfPages(fileBuffer)
  const creditsUsed = calcPaperCredits(pages)
  const requestId = uuidv4()

  try {
    await deductCredits(userId, creditsUsed, {
      description: `MinerU 论文解析: ${fileName} (${pages} 页)`,
      referenceType: 'mineru_parse',
      referenceId: requestId,
    })
  } catch (err) {
    if (err.message?.startsWith('INSUFFICIENT_CREDITS')) {
      const balance = err.message.split(':')[1] || '0'
      return c.json({ error: '积分不足', message: `当前余额不足，本次需要 ${creditsUsed} 积分（${pages} 页）`, balance: parseInt(balance, 10), required: creditsUsed }, 402)
    }
    console.error('[mineru] 积分扣减失败:', err.message)
    return c.json({ error: '积分扣减异常' }, 500)
  }

  // ---- MinerU v4 批量上传 + 轮询 ----
  try {
    console.log(`[mineru] 开始: ${fileName} (${pages} 页, ${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB, ${creditsUsed} 积分)`)

    // Step 1: 申请上传 URL
    const { batch_id, file_urls } = await requestUploadUrls(fileName)
    console.log(`[mineru] batch_id=${batch_id}`)

    // Step 2: PUT 上传到 OSS
    await uploadToOss(file_urls[0], fileBuffer)
    console.log('[mineru] OSS 上传完成')

    // Step 3: 轮询结果（传递 includeStructuredJson 参数）
    const includeStructured = formData.includeStructuredJson === 'true'
    const result = await pollBatchResult(batch_id, includeStructured)

    if (!result.markdown || result.markdown.trim().length === 0) {
      return c.json({ error: '论文解析结果为空，请确认 PDF 是否为扫描件且 OCR 已启用' }, 422)
    }

    console.log(`[mineru] 完成: ${fileName} → ${result.markdown.length} 字符 Markdown${includeStructured ? ' + 结构化 JSON' : ''}`)

    const responseBody = {
      markdown: result.markdown,
      pages,
      creditsUsed,
    }

    // 如果有结构化数据，附加到响应中
    if (includeStructured && result.contentList) {
      responseBody.contentList = result.contentList
    }
    if (includeStructured && result.metadata) {
      responseBody.metadata = result.metadata
    }

    return c.json(responseBody)
  } catch (err) {
    console.error('[mineru] 解析失败:', err.message)
    return c.json({ error: '论文解析失败', message: err.message }, 502)
  }
})
