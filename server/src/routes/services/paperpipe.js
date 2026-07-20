/**
 * paperpipe 论文管理代理路由
 *
 * 将所有请求代理到宿主机的 paperpipe HTTP Bridge（paperpipe-bridge.service）。
 * Bridge 再调用 papi CLI，每用户 PAPER_DB_PATH 隔离。
 *
 * 架构：
 *   客户端 → Profer Server (Docker) → host.docker.internal:9876 → paperpipe-bridge → papi CLI
 *
 * MinerU 保留：本地 PDF → 高质量 Markdown 解析（非 arXiv 论文）
 */

import { Hono } from 'hono'
import { isBodyTooLargeError } from '../../middleware/body-limit.js'
import { PAPERPIPE_MAX_FILE_SIZE } from '../../config.js'
import { extractRemotePaperId, getPaperpipeBridgeConfig, hasPdfMagicBytes, isSafePaperpipeId, normalizePaperpipeSearchInput, sanitizePaperFilename } from './paperpipe-helpers.js'

export const paperpipeRoutes = new Hono()

/** Paperpipe HTTP Bridge 配置。生产环境必须有服务间密钥。 */
const BRIDGE_CONFIG = getPaperpipeBridgeConfig()
const BRIDGE_URL = BRIDGE_CONFIG.url
const BRIDGE_SECRET = BRIDGE_CONFIG.secret

function bridgeUnavailableResponse() {
  return { error: '论文服务尚未完成管理员配置', code: 'PAPERPIPE_BRIDGE_NOT_CONFIGURED' }
}

function ensureBridgeConfigured(c) {
  if (BRIDGE_CONFIG.ready) return undefined
  return c.json(bridgeUnavailableResponse(), 503)
}

// ===== 工具函数 =====

/**
 * 代理请求到 paperpipe bridge，自动注入 X-User-Id
 */
async function bridgeProxy(userId, method, path, body = undefined, timeout = 120_000) {
  const url = `${BRIDGE_URL}${path}`
  const headers = {
    ...(userId ? { 'X-User-Id': String(userId) } : {}),
    ...(BRIDGE_SECRET ? { 'X-Paperpipe-Internal-Key': BRIDGE_SECRET } : {}),
  }
  const fetchOpts = {
    method,
    headers,
    signal: AbortSignal.timeout(timeout),
  }

  if (body) {
    fetchOpts.headers['Content-Type'] = 'application/json'
    fetchOpts.body = JSON.stringify(body)
  }

  try {
    const resp = await fetch(url, fetchOpts)
    const data = await resp.json().catch(() => ({ error: '无法解析 bridge 响应' }))
    return { status: resp.status, data }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { status: 504, data: { error: 'paperpipe 服务超时' } }
    }
    console.error('[paperpipe] bridge 连接失败:', err.message)
    return { status: 502, data: { error: 'paperpipe 服务不可用，请联系管理员' } }
  }
}

/** 桥接 multipart 文件上传 */
async function bridgeUpload(userId, fileBuffer, fileName, clientPaperId) {
  const boundary = `----Paperpipe${Date.now()}${Math.random().toString(36).slice(2)}`
  const crlf = '\r\n'

  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${sanitizePaperFilename(fileName)}"`,
    `Content-Type: application/pdf`,
    '',
    '',
  ].join(crlf)

  const footer = `${crlf}--${boundary}--${crlf}`
  const headerBuffer = Buffer.from(header, 'utf-8')
  const footerBuffer = Buffer.from(footer, 'utf-8')
  const body = Buffer.concat([headerBuffer, fileBuffer, footerBuffer])

  try {
    const resp = await fetch(`${BRIDGE_URL}/upload`, {
      method: 'POST',
      headers: {
        'X-User-Id': String(userId),
        ...(BRIDGE_SECRET ? { 'X-Paperpipe-Internal-Key': BRIDGE_SECRET } : {}),
        ...(clientPaperId ? { 'X-Client-Paper-Id': clientPaperId } : {}),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(300_000),
    })
    const data = await resp.json().catch(() => ({ error: '无法解析 bridge 响应' }))
    return { status: resp.status, data }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { status: 504, data: { error: 'paperpipe 上传超时' } }
    }
    console.error('[paperpipe] bridge 上传失败:', err.message)
    return { status: 502, data: { error: 'paperpipe 服务不可用' } }
  }
}

// ===== 路由 =====

/**
 * POST /add — 通过 arXiv ID 添加论文
 */
paperpipeRoutes.post('/add', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未提供认证令牌' }, 401)
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  let body
  try { body = await c.req.json() } catch {
    return c.json({ error: '请求体格式错误' }, 400)
  }

  const { arxivId, tags } = body
  if (!arxivId || typeof arxivId !== 'string') {
    return c.json({ error: '请提供有效的 arXiv ID' }, 400)
  }

  const cleanId = arxivId.trim().replace(/^arxiv:/i, '')
  if (!/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(cleanId)) {
    return c.json({ error: `arXiv ID 格式不正确: ${cleanId}` }, 400)
  }

  const { status, data } = await bridgeProxy(userId, 'POST', '/add', {
    arxivId: cleanId,
    tags,
  }, 300_000)

  return c.json(data, status)
})

/**
 * POST /upload — 上传本地 PDF
 */
paperpipeRoutes.post('/upload', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未提供认证令牌' }, 401)
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  try {
    const formData = await c.req.parseBody()
    const file = formData.file
    if (!file) return c.json({ error: '请上传 PDF 文件' }, 400)

    let fileBuffer, fileName
    if (file instanceof File) {
      fileName = file.name
      fileBuffer = Buffer.from(await file.arrayBuffer())
    } else if (file && typeof file === 'object') {
      fileName = file.name || 'paper.pdf'
      if (file.data) {
        fileBuffer = Buffer.from(file.data)
      } else {
        return c.json({ error: '无法读取上传文件' }, 400)
      }
    } else {
      return c.json({ error: '不支持的文件格式' }, 400)
    }

    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return c.json({ error: '仅支持 PDF 文件' }, 400)
    }
    if (fileBuffer.length === 0) return c.json({ error: '文件为空' }, 400)
    if (fileBuffer.length > PAPERPIPE_MAX_FILE_SIZE) {
      return c.json({ error: `文件超过 ${Math.round(PAPERPIPE_MAX_FILE_SIZE / 1048576)}MB 上限`, code: 'PAPERPIPE_FILE_TOO_LARGE' }, 413)
    }
    if (!hasPdfMagicBytes(fileBuffer)) return c.json({ error: '文件不是有效的 PDF 格式', code: 'PAPERPIPE_INVALID_PDF' }, 415)

    const clientPaperId = c.req.header('x-client-paper-id')
    if (clientPaperId && !isSafePaperpipeId(clientPaperId)) return c.json({ error: '论文标识无效' }, 400)
    const { status, data } = await bridgeUpload(userId, fileBuffer, fileName, clientPaperId)
    const remoteId = extractRemotePaperId(data)
    return c.json(remoteId ? { ...data, remoteId } : data, status)
  } catch (err) {
    if (isBodyTooLargeError(err)) return c.json({ error: '上传请求体过大', code: 'PAPERPIPE_BODY_TOO_LARGE' }, 413)
    console.error('[paperpipe] upload 失败:', err instanceof Error ? err.message : err)
    return c.json({ error: '上传失败，请稍后重试', code: 'PAPERPIPE_UPLOAD_FAILED' }, 500)
  }
})

/**
 * GET /list — 列出所有论文
 */
paperpipeRoutes.get('/list', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未提供认证令牌' }, 401)
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  const { status, data } = await bridgeProxy(userId, 'GET', '/list')
  return c.json(data, status)
})

/**
 * GET /show/:paperName — 获取单篇论文内容
 */
paperpipeRoutes.get('/show/:paperName', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未提供认证令牌' }, 401)
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  const paperName = c.req.param('paperName')
  if (!isSafePaperpipeId(paperName)) return c.json({ error: '论文标识无效' }, 400)

  const { status, data } = await bridgeProxy(userId, 'GET', `/show/${encodeURIComponent(paperName)}`)
  return c.json(data, status)
})

/**
 * DELETE /remove/:paperName — 删除论文
 */
paperpipeRoutes.delete('/remove/:paperName', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未提供认证令牌' }, 401)
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  const paperName = c.req.param('paperName')
  if (!isSafePaperpipeId(paperName)) return c.json({ error: '论文标识无效' }, 400)

  const { status, data } = await bridgeProxy(userId, 'DELETE', `/remove/${encodeURIComponent(paperName)}`)
  return c.json(data, status)
})

/**
 * POST /search — 搜索论文
 */
paperpipeRoutes.post('/search', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未提供认证令牌' }, 401)
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  let body
  try { body = await c.req.json() } catch {
    return c.json({ error: '请求体格式错误' }, 400)
  }

  const parsed = normalizePaperpipeSearchInput(body)
  if (!parsed.value) return c.json({ error: parsed.error }, 400)

  const { status, data } = await bridgeProxy(userId, 'POST', '/search', parsed.value)
  return c.json(data, status)
})

/**
 * GET /health — 检查 paperpipe 是否可用
 */
paperpipeRoutes.get('/health', async (c) => {
  const unavailable = ensureBridgeConfigured(c)
  if (unavailable) return unavailable

  // Bridge health 必须是无用户状态、无副作用的基础设施端点。
  const { status, data } = await bridgeProxy('', 'GET', '/health')
  return c.json(data, status)
})
