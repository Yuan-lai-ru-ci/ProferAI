import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SEARCH_URL = 'https://api.tavily.com/search'
const EXTRACT_URL = 'https://api.tavily.com/extract'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESULTS = 10
const MAX_CHARS = 80_000

export type WebSearchDepth = 'basic' | 'advanced'

export interface WebServiceConfig {
  apiKey?: string
  enabled?: boolean
}

/** 文件仅从所属 Core 配置根读取；显式参数（含禁用状态）优先。 */
export function loadCoreWebServiceConfig(configDir: string, overrides: WebServiceConfig = {}): WebServiceConfig {
  const path = join(configDir, 'web-search.json')
  let stored: WebServiceConfig = {}
  if (existsSync(path)) {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core网页搜索配置格式无效')
    const record = value as Record<string, unknown>
    if (record.apiKey !== undefined && typeof record.apiKey !== 'string') throw new Error('Core网页搜索apiKey必须是字符串')
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new Error('Core网页搜索enabled必须是布尔值')
    stored = { ...(typeof record.apiKey === 'string' ? { apiKey: record.apiKey } : {}), ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}) }
  }
  return { ...stored, ...overrides }
}

export interface WebSearchOptions {
  query: string
  maxResults?: number
  searchDepth?: WebSearchDepth
  includeDomains?: string[]
  excludeDomains?: string[]
  signal?: AbortSignal
}

export interface WebFetchOptions {
  url: string
  prompt?: string
  extractDepth?: WebSearchDepth
  maxChars?: number
  signal?: AbortSignal
}

export interface TavilySearchResponse {
  results: Array<{ title: string; url: string; content: string; score?: number }>
  answer?: string
  response_time?: number
  request_id?: string
  usage?: { credits?: number }
}

export interface TavilyExtractResponse {
  results: Array<{ url: string; raw_content?: string | null }>
  failed_results?: Array<{ url: string; error?: string }>
  response_time?: number
  request_id?: string
  usage?: { credits?: number }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function list(value: string[] | undefined): string[] | undefined {
  const result = value?.map(item => item.trim()).filter(Boolean)
  return result && result.length > 0 ? result : undefined
}

function httpUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https URL')
  return url.toString()
}

async function post<T>(url: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Tavily请求超时')), DEFAULT_TIMEOUT_MS)
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: controller.signal })
    if (!response.ok) throw new Error(`Tavily请求失败 (${response.status}): ${(await response.text().catch(() => '')) || response.statusText}`)
    return await response.json() as T
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export function isWebServiceAvailable(config: WebServiceConfig): boolean {
  return config.enabled !== false && Boolean(config.apiKey?.trim())
}

export async function searchWeb(config: WebServiceConfig, options: WebSearchOptions): Promise<TavilySearchResponse> {
  if (config.enabled === false) throw new Error('Core网页搜索已禁用')
  const apiKey = config.apiKey?.trim()
  if (!apiKey) throw new Error('Core未配置Tavily API Key')
  const query = options.query.trim()
  if (!query) throw new Error('query不能为空')
  const data = await post<TavilySearchResponse>(SEARCH_URL, apiKey, {
    query, search_depth: options.searchDepth ?? 'basic', max_results: clamp(options.maxResults, 5, 1, MAX_RESULTS), include_answer: true,
    include_raw_content: false, ...(list(options.includeDomains) ? { include_domains: list(options.includeDomains) } : {}),
    ...(list(options.excludeDomains) ? { exclude_domains: list(options.excludeDomains) } : {}),
  }, options.signal)
  options.signal?.throwIfAborted()
  if (!Array.isArray(data.results) || data.results.some(result => !result || typeof result.title !== 'string' || typeof result.url !== 'string' || typeof result.content !== 'string')) {
    throw new Error('Tavily返回了无效搜索结果')
  }
  return data
}

export async function fetchWebPage(config: WebServiceConfig, options: WebFetchOptions): Promise<TavilyExtractResponse> {
  if (config.enabled === false) throw new Error('Core网页搜索已禁用')
  const apiKey = config.apiKey?.trim()
  if (!apiKey) throw new Error('Core未配置Tavily API Key')
  const url = httpUrl(options.url)
  const maxChars = clamp(options.maxChars, 20_000, 1_000, MAX_CHARS)
  const data = await post<TavilyExtractResponse>(EXTRACT_URL, apiKey, { urls: url, ...(options.prompt?.trim() ? { query: options.prompt.trim() } : {}), extract_depth: options.extractDepth ?? 'basic', include_images: false, include_favicon: true, format: 'markdown' }, options.signal)
  options.signal?.throwIfAborted()
  if (!Array.isArray(data.results) || data.results.some(result => !result || typeof result.url !== 'string' || result.raw_content != null && typeof result.raw_content !== 'string')) {
    throw new Error('Tavily返回了无效抓取结果')
  }
  if (!data.results.length) throw new Error(`Tavily未能抓取网页：${data.failed_results?.map(result => result.error ?? 'unknown error').join('; ') || '没有可用结果'}`)
  return { ...data, results: data.results.map(result => ({ ...result, raw_content: result.raw_content?.slice(0, maxChars) })) }
}

export function formatSearchResults(data: TavilySearchResponse): string {
  const lines = data.answer ? [`**概要：** ${data.answer}`, ''] : []
  if (!data.results.length) return [...lines, '未找到相关结果。'].join('\n')
  lines.push('**搜索结果：**')
  data.results.forEach((result, index) => lines.push(`${index + 1}. [${result.title}](${result.url})\n   ${result.content.slice(0, 500)}`))
  return lines.join('\n')
}

export function formatFetchResults(data: TavilyExtractResponse): string {
  const parts: string[] = []
  data.results.forEach(result => parts.push(`# ${result.url}\n\n${result.raw_content?.trim() || '未提取到网页正文。'}`))
  data.failed_results?.forEach(result => parts.push(`抓取失败：${result.url}：${result.error ?? 'unknown error'}`))
  return parts.length ? parts.join('\n\n') : '未提取到网页内容。'
}
