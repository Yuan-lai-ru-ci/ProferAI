/**
 * 论文精读服务 — 代理 MinerU API 解析 PDF
 *
 * 负责：打开文件对话框选择 PDF → 上传到 Profer 服务端 → 服务端代理调用 MinerU API → 返回 Markdown
 * MinerU API key 完全在服务端代管，客户端不接触。
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { dialog, BrowserWindow } from 'electron'
import { getTeamAuthWithRefresh } from './auth-service'
import type { PaperParseResult, PageEstimate } from '@profer/shared'

// esbuild bundle 中 undici 的 FormData 全局注入可能因模块初始化顺序而未执行。
// 这里兜底：如果 globalThis.FormData 不存在，从 undici 主动导入并挂载。
if (typeof globalThis.FormData === 'undefined') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require('undici')
    if (undici.FormData) {
      ;(globalThis as Record<string, unknown>).FormData = undici.FormData
    }
  } catch {
    // 忽略 — 如果 undici 也不可用，后续 fetch 调用会自行报错
  }
}

export type { PaperParseResult, PageEstimate }

/** 每 10 页消耗积分（与服务端 mineru.js 保持一致） */
const CREDITS_PER_10_PAGES = 2

/** 大于此页数需要用户确认 */
const LARGE_PAPER_THRESHOLD = 50

/**
 * 从 PDF Buffer 估算页数（与服务端 mineru.js 的 estimatePdfPages 逻辑一致）
 */
function estimatePdfPages(buffer: Buffer): number {
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
function calcPaperCredits(pages: number): number {
  return Math.max(1, Math.ceil(pages / 10) * CREDITS_PER_10_PAGES)
}

/**
 * 估算 PDF 论文的页数和积分消耗（不调用服务端）
 */
export function estimatePaperPages(filePath: string): PageEstimate {
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.pdf') {
    throw new Error('仅支持 PDF 文件')
  }
  const buffer = readFileSync(filePath)
  if (buffer.length === 0) {
    throw new Error('文件为空')
  }
  const pages = estimatePdfPages(buffer)
  return { pages, estimatedCredits: calcPaperCredits(pages) }
}

/** 大于此页数需要用户确认 */
export { LARGE_PAPER_THRESHOLD }

/**
 * 调用服务端 MinerU 代理解析 PDF 论文
 *
 * @param filePath PDF 文件的绝对路径
 * @returns 解析结果（Markdown + 页数 + 积分消耗）
 * @throws 认证过期、积分不足、解析失败等错误
 */
export async function parsePaper(filePath: string): Promise<PaperParseResult> {
  try {
  // ---- 校验文件扩展名 ----
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.pdf') {
    throw new Error('仅支持 PDF 文件')
  }

  // ---- 读取文件 ----
  const fileBuffer = readFileSync(filePath)
  if (fileBuffer.length === 0) {
    throw new Error('文件为空')
  }
  if (fileBuffer.length > 50 * 1024 * 1024) {
    throw new Error('文件超过 50MB 上限，请压缩后重试')
  }

  const fileName = (filePath.split(/[/\\]/).pop() || 'unknown.pdf').replace(/"/g, "'")

  // ---- 获取团队认证 ----
  const auth = await getTeamAuthWithRefresh()
  if (!auth) {
    throw new Error('未登录团队账号，论文精读需要登录 Profer 团队服务')
  }

  const token = auth.proxyToken || auth.token
  const baseUrl = auth.baseUrl.replace(/\/+$/, '') // 去掉尾部斜杠

  // ---- 构建 multipart/form-data ----
  // Node.js 没有 FormData / Blob，用 Buffer + 手动构建 boundary
  const boundary = `----MinerU${Date.now()}${Math.random().toString(36).slice(2)}`
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

  // ---- 调用服务端代理 ----
  console.log(`[论文精读] 开始解析: ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB)`)

  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/v1/services/mineru/parse`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(600_000), // 服务端最长可跑 ~510s（上传+轮询+下载），留足余量
    })
  } catch (fetchErr: unknown) {
    const errMsg = (fetchErr as Error).message || String(fetchErr)
    // 网络错误：无法连接服务器
    if (errMsg.includes('fetch failed') || errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND')) {
      throw new Error(`无法连接团队服务器 (${baseUrl})，请确认服务已启动`)
    }
    throw new Error(`网络请求失败: ${errMsg}`)
  }

  // ---- 处理响应 ----
  if (resp.status === 401) {
    throw new Error('登录已过期，请重新登录团队账号')
  }

  if (resp.status === 402) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.message || '积分不足，请充值后重试')
  }

  if (resp.status === 413) {
    throw new Error('文件过大，请压缩后重试')
  }

  if (resp.status === 503) {
    throw new Error('论文解析服务暂未配置，请联系管理员配置 MinerU API Key')
  }

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    const msg = data.message || data.error || `服务端错误 (${resp.status})`
    throw new Error(msg)
  }

  const result = await resp.json()

  if (!result.markdown || result.markdown.trim().length === 0) {
    throw new Error('论文解析结果为空，请确认 PDF 是否为可读文本（非扫描件）')
  }

  console.log(`[论文精读] 解析完成: ${fileName} → ${result.markdown.length} 字符 Markdown (${result.pages} 页, ${result.creditsUsed} 积分)`)

  return {
    markdown: result.markdown,
    pages: result.pages,
    creditsUsed: result.creditsUsed,
    images: result.images || [],
  }
  } catch (err: unknown) {
    const e = err as Error
    console.error('[parsePaper] 内部错误 — 完整堆栈:')
    console.error(e.stack || e.message || String(e))
    throw err
  }
}

/**
 * 打开文件对话框选择 PDF 并解析
 *
 * 一体式流程：打开原生文件对话框（仅 PDF） → 读取文件 → 上传到服务端 → 返回 Markdown
 * renderer 只需调用一次即可获得解析结果
 *
 * @returns 解析结果，用户取消对话框则返回 null
 */
export async function selectAndParsePaper(): Promise<PaperParseResult | null> {
  const parentWindow = BrowserWindow.getFocusedWindow()
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, {
        title: '选择论文 PDF',
        properties: ['openFile'],
        filters: [
          { name: 'PDF 文件', extensions: ['pdf'] },
        ],
      })
    : await dialog.showOpenDialog({
        title: '选择论文 PDF',
        properties: ['openFile'],
        filters: [
          { name: 'PDF 文件', extensions: ['pdf'] },
        ],
      })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]!

  return parsePaper(filePath)
}
