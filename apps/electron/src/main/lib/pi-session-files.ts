import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { getPiTranscriptDirForSession, getSdkConfigDir } from './config-paths'

/**
 * Pi 原生 transcript（`<sdk-config>/sessions/pi/**\/*.jsonl`）路径解析。
 *
 * 删除会话、健康检查、迁移工作区都只需要「sessionId → 文件路径」这一件事。
 * 旧实现每次都递归读取整棵目录树：本机 1327 个文件 / 2.85GB，实测 2.9s，
 * 而每个文件其实只用到首行 header。
 *
 * 这里的约定：
 * - 索引里已记录 `piSessionFile` 时优先使用，但必须通过「路径在根目录内 + 首行
 *   header.id 精确相等」双重校验，绝不按文件名匹配、绝不误删另一会话；
 * - 未记录或校验失败时，用只读首行的扫描建立 id → path 索引并缓存；
 * - 同一 sessionId 命中多个文件时视为歧义，返回 undefined（与旧实现一致）。
 */

/** 首行 header 通常 < 200B；留 16KB 余量足以覆盖异常长行。 */
const HEADER_READ_BYTES = 16 * 1024
const DEFAULT_CACHE_TTL_MS = 30_000

export interface PiTranscriptLookupOptions {
  /** Pi transcript 根目录，默认 `<sdk-config>/sessions/pi`。 */
  rootDir?: string
  /** 扫描缓存有效期，默认 30s。 */
  cacheTtlMs?: number
  /** 注入时间源，便于测试。 */
  now?: () => number
  /** 忽略缓存强制重建。 */
  force?: boolean
  /** 已知路径不可用时是否强制重建一次（删除路径用，避免缓存窗口内漏删）。 */
  refreshOnFallback?: boolean
}

interface TranscriptCache {
  rootDir: string
  builtAt: number
  byId: Map<string, string[]>
}

let cache: TranscriptCache | null = null

export function getPiTranscriptDir(): string {
  return join(getSdkConfigDir(), 'sessions', 'pi')
}

/** 与 agent-session-manager 中的同名实现保持同一判定：只接受根目录内的路径。 */
function isPathWithin(rootDir: string, candidate: string): boolean {
  const rel = relative(resolve(rootDir), resolve(candidate))
  return Boolean(rel)
    && rel !== '..'
    && !rel.startsWith('../')
    && !rel.startsWith('..\\')
    && !isAbsolute(rel)
}

/** 只读首行并解析 header；任何异常都按「无法确认」处理。 */
export function readPiSessionHeaderId(filePath: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytes <= 0) return undefined
    let text = buffer.toString('utf8', 0, bytes)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const lineEnd = text.indexOf('\n')
    const line = lineEnd >= 0 ? text.slice(0, lineEnd) : text
    const header = JSON.parse(line) as { type?: unknown; id?: unknown }
    return header?.type === 'session' && typeof header.id === 'string' ? header.id : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** 校验已知路径确实属于该 session：路径在根目录内且 header.id 相等。 */
export function isPiTranscriptPathFor(
  sessionId: string,
  filePath: string,
  options: Pick<PiTranscriptLookupOptions, 'rootDir'> = {},
): boolean {
  const rootDir = options.rootDir ?? getPiTranscriptDirForSession(sessionId)
  if (!isPathWithin(rootDir, filePath)) return false
  if (!existsSync(filePath)) return false
  return readPiSessionHeaderId(filePath) === sessionId
}

function scanTranscripts(rootDir: string): Map<string, string[]> {
  const byId = new Map<string, string[]>()
  const walk = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(candidate)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const id = readPiSessionHeaderId(candidate)
      if (!id) continue
      const matches = byId.get(id) ?? []
      matches.push(candidate)
      byId.set(id, matches)
    }
  }
  walk(rootDir)
  return byId
}

/** 供健康检查等批量场景复用同一份扫描结果。 */
export function getPiTranscriptIndex(options: PiTranscriptLookupOptions = {}): Map<string, string[]> {
  const rootDir = options.rootDir ?? getPiTranscriptDir()
  const now = options.now?.() ?? Date.now()
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  if (!options.force && cache && cache.rootDir === rootDir && now - cache.builtAt <= ttl) {
    return cache.byId
  }
  if (!existsSync(rootDir)) {
    cache = { rootDir, builtAt: now, byId: new Map() }
    return cache.byId
  }
  const byId = scanTranscripts(rootDir)
  cache = { rootDir, builtAt: now, byId }
  return byId
}

/** 仅清理缓存；删除/迁移后调用，避免 30s 窗口内读到已失效路径。 */
export function invalidatePiTranscriptCache(rootDir?: string): void {
  if (!rootDir || cache?.rootDir === rootDir) cache = null
}

/**
 * 解析会话的 Pi transcript 路径。
 *
 * 先信任索引里的 `piSessionFile`（校验通过即返回），再回退到缓存扫描。
 * 返回值一定已经过 header 校验，调用方可以直接 unlink。
 */
export function resolvePiTranscriptPath(
  sessionId: string,
  knownPath?: string,
  options: PiTranscriptLookupOptions = {},
): string | undefined {
  // sessionId 可能是 SDK id；调用方拿不到 Profer 会话 id 时必须显式传 rootDir。
  const rootDir = options.rootDir ?? getPiTranscriptDirForSession(sessionId)
  if (knownPath && isPiTranscriptPathFor(sessionId, knownPath, { rootDir })) return knownPath
  const matches = getPiTranscriptIndex(
    options.refreshOnFallback ? { ...options, rootDir, force: true } : { ...options, rootDir },
  ).get(sessionId)
  return matches && matches.length === 1 ? matches[0] : undefined
}

/** 删除会话等场景的兼容入口：与旧 `findPiSessionJsonl` 语义一致（歧义返回 undefined）。 */
export function findPiSessionJsonlCached(
  sessionId: string,
  options: PiTranscriptLookupOptions = {},
): string | undefined {
  const rootDir = options.rootDir ?? getPiTranscriptDirForSession(sessionId)
  const matches = getPiTranscriptIndex({ ...options, rootDir }).get(sessionId)
  return matches && matches.length === 1 ? matches[0] : undefined
}
