/**
 * 新标签页起始页数据存储
 *
 * 持久化书签与最近访问历史，数据量小、写入频繁，独立于 settings.json
 * 避免污染应用设置。数据仅保存在本机 ~/.profer/ 下，与其他用户级配置一致，
 * 采用全局单一维度（与浏览器 profile 的全局单一身份对齐），不分工作区隔离。
 *
 * 存储结构：{ bookmarks: BrowserBookmark[], history: BrowserHistoryEntry[] }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, extname } from 'node:path'
import { getBrowserStartPagePath } from './config-paths'
import type { BrowserBookmark, BrowserHistoryEntry } from '@profer/shared'

/** 最近访问历史保留条数上限。 */
const MAX_HISTORY_ENTRIES = 50

interface StartPageStoreFile {
  bookmarks: BrowserBookmark[]
  history: BrowserHistoryEntry[]
}

/** 内存缓存：避免启动后多次 IPC 调用反复读磁盘。 */
let _cache: StartPageStoreFile | null = null

function defaultStore(): StartPageStoreFile {
  return { bookmarks: [], history: [] }
}

function readStore(): StartPageStoreFile {
  if (_cache) return _cache
  const filePath = getBrowserStartPagePath()
  if (!existsSync(filePath)) {
    _cache = defaultStore()
    return _cache
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<StartPageStoreFile>
    _cache = {
      bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
      history: Array.isArray(data.history) ? data.history : [],
    }
  } catch (error) {
    console.error('[起始页] 读取数据失败，回退空状态:', error)
    _cache = defaultStore()
  }
  return _cache
}

function writeStore(): void {
  if (!_cache) return
  const filePath = getBrowserStartPagePath()
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(filePath, JSON.stringify(_cache, null, 2), 'utf-8')
  } catch (error) {
    console.error('[起始页] 写入数据失败:', error)
  }
}

/** 归一化 URL，只保留 protocol + host + path（去掉 hash/query 敏感片段），用于历史去重。 */
function normalizeHistoryKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return null
  }
}

/** 从 URL 推断 favicon 目标地址。 */
export function faviconUrlFor(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.protocol}//${parsed.host}/favicon.ico`
  } catch {
    return null
  }
}

/** 读取全部书签。 */
export function listBookmarks(): BrowserBookmark[] {
  return [...readStore().bookmarks]
}

/** 新增书签；相同 URL 重复添加时更新 title 并前移。 */
export function addBookmark(title: string, url: string, favicon: string): BrowserBookmark[] {
  const store = readStore()
  const normalized = url.trim()
  const existing = store.bookmarks.find((b) => b.url === normalized)
  if (existing) {
    existing.title = title.trim() || existing.title
    if (favicon) existing.favicon = favicon
    return [...store.bookmarks]
  }
  const bookmark: BrowserBookmark = {
    id: randomUUID(),
    title: title.trim() || '未命名站点',
    url: normalized,
    favicon: favicon || '',
    createdAt: Date.now(),
  }
  store.bookmarks = [bookmark, ...store.bookmarks]
  writeStore()
  // 后台抓取 favicon 并回填，不阻塞返回。
  void fetchFaviconDataUrl(normalized).then((favicon) => {
    if (favicon) patchBookmarkFavicon(normalized, favicon)
  })
  return [...store.bookmarks]
}

/** 删除书签。 */
export function removeBookmark(id: string): BrowserBookmark[] {
  const store = readStore()
  store.bookmarks = store.bookmarks.filter((b) => b.id !== id)
  writeStore()
  return [...store.bookmarks]
}

/** 记录一次访问历史（按 host+path 去重，最近访问靠前）。 */
export function recordHistory(url: string, title: string): void {
  const key = normalizeHistoryKey(url)
  if (!key) return
  const store = readStore()
  const titleText = title.trim() || key
  const idx = store.history.findIndex((h) => normalizeHistoryKey(h.url) === key)
  const entry: BrowserHistoryEntry = { url, title: titleText, lastVisitedAt: Date.now() }
  if (idx >= 0) {
    store.history.splice(idx, 1)
  }
  store.history = [entry, ...store.history].slice(0, MAX_HISTORY_ENTRIES)
  writeStore()
}

/** 读取最近访问历史（已按时间倒序）。 */
export function listHistory(): BrowserHistoryEntry[] {
  return [...readStore().history]
}

/** 清空最近访问历史。 */
export function clearHistory(): void {
  const store = readStore()
  store.history = []
  writeStore()
}

/** 更新某条书签的 favicon（后台异步抓取后回填），返回是否命中。 */
export function patchBookmarkFavicon(url: string, favicon: string): boolean {
  const store = readStore()
  const bookmark = store.bookmarks.find((b) => b.url === url)
  if (!bookmark) return false
  bookmark.favicon = favicon
  writeStore()
  return true
}

const FAVICON_MAX_BYTES = 64 * 1024
const FAVICON_FETCH_TIMEOUT_MS = 5000

const FAVICON_MIME: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * 异步抓取站点 favicon，返回 data URL（失败返回空串）。
 * 先在主进程拉取站点 `/favicon.ico`，失败或过大时回退到 Google favicon 服务。
 * 结果由调用方决定是否 patchBookmarkFavicon 回填。
 */
export async function fetchFaviconDataUrl(url: string): Promise<string> {
  const base = faviconUrlFor(url)
  if (!base) return ''
  for (const target of [base, `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).host)}&sz=64`]) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT_MS)
      const response = await fetch(target, { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > FAVICON_MAX_BYTES) continue
      const mime = FAVICON_MIME[extname(new URL(target).pathname).toLowerCase()]
        ?? response.headers.get('content-type')?.split(';')[0]?.trim()
        ?? 'image/x-icon'
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch {
      continue
    }
  }
  return ''
}

/** 后台补齐所有缺失 favicon 的书签；App 启动或新增书签时调用，不阻塞主流程。 */
export function backfillMissingFavicons(): void {
  const store = readStore()
  for (const bookmark of store.bookmarks) {
    if (bookmark.favicon) continue
    void fetchFaviconDataUrl(bookmark.url).then((favicon) => {
      if (favicon) patchBookmarkFavicon(bookmark.url, favicon)
    })
  }
}
