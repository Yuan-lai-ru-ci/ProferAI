/**
 * 工作区热力图 Token 聚合服务
 *
 * 扫描会话 JSONL 文件，按天聚合 token 消耗（input + output）。
 * 结果缓存到 ~/.profer/heatmap-cache/{workspaceId}.json，
 * 任意会话的 updatedAt 变化时自动重建缓存。
 *
 * 数据来源：每个会话 JSONL 中 **所有** type=result 消息的 usage 字段。
 * 日期归属：每条 result 消息按自身的 _createdAt 归入对应日期。
 *   — 一个跨越多天的会话，token 会正确拆分到各天，而不是全部归到最后一天。
 * 自配/代管用户统一走此路径，不依赖服务端 API。
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir, getAgentSessionMessagesPath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

// ── 类型 ──────────────────────────────────────────────────

export interface HeatmapDailyEntry {
  date: string
  tokens: number
}

/** 缓存格式版本：结构变更时递增以自动淘汰旧缓存 */
const CACHE_VERSION = 2

interface HeatmapCache {
  /** 缓存格式版本 */
  version: number
  /** 每个活跃会话的 updatedAt 快照，用于缓存失效判断：sessionId → updatedAt */
  sessionTimestamps: Record<string, number>
  /** 缓存时间戳 */
  cachedAt: number
  /** 按天聚合的 token 数据 */
  daily: HeatmapDailyEntry[]
}

// ── 路径 ──────────────────────────────────────────────────

function getCacheDir(): string {
  const dir = join(getConfigDir(), 'heatmap-cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getCachePath(workspaceId: string): string {
  return join(getCacheDir(), `${workspaceId}.json`)
}

// ── JSONL 读取 ────────────────────────────────────────────

/**
 * 逐条解析会话 JSONL 中所有 type=result 消息，
 * 按每条消息的 _createdAt 日期汇总当日 token 消耗。
 *
 * 返回 Map<date, tokens>，key 为 ISO 日期 "YYYY-MM-DD"。
 * 文件不存在或无合法 result 消息时返回空 Map。
 */
function extractSessionDailyTokens(sessionId: string): Map<string, number> {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return new Map()

  let lines: string[]
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n')
  } catch {
    return new Map()
  }

  const dayMap = new Map<string, number>()

  for (const line of lines) {
    if (!line || !line.trim()) continue

    let parsed: {
      type?: string
      usage?: { input_tokens?: number; output_tokens?: number }
      _createdAt?: number
    }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (parsed.type === 'result' && parsed.usage && parsed._createdAt) {
      const tokens = (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0)
      if (tokens > 0) {
        const date = new Date(parsed._createdAt).toISOString().slice(0, 10)
        dayMap.set(date, (dayMap.get(date) ?? 0) + tokens)
      }
    }
  }

  return dayMap
}

// ── 聚合 ──────────────────────────────────────────────────

/**
 * 扫描工作区下所有非归档会话，逐条解析 JSONL 中所有 result 消息，
 * 按每条消息的实际发生日期（_createdAt）聚合每日 token 消耗。
 *
 * 与旧实现的区别：
 * - 旧：只读最后一条 result，全部 token 归到一天 → **不准**
 * - 新：逐条 result 按日期拆分 → 跨天会话 token 正确分布到各天
 *
 * 返回按日期升序排列的条目列表（最近 365 天）。
 */
export function buildWorkspaceTokenDaily(
  _workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 365)

  const dayMap = new Map<string, number>()

  for (const session of sessions) {
    if (session.archived) continue

    const sessionDays = extractSessionDailyTokens(session.id)

    for (const [date, tokens] of sessionDays) {
      // 跳过超出范围的数据（先快速字符串比较：ISO 日期天然可比）
      if (date < cutoff.toISOString().slice(0, 10)) continue
      dayMap.set(date, (dayMap.get(date) ?? 0) + tokens)
    }
  }

  return Array.from(dayMap.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ── 缓存读写 ──────────────────────────────────────────────

function readCache(workspaceId: string): HeatmapCache | null {
  const path = getCachePath(workspaceId)
  const data = readJsonFileSafe<HeatmapCache>(path)
  if (!data) return null
  // 版本不匹配 → 淘汰旧缓存
  if (data.version !== CACHE_VERSION) return null
  if (!Array.isArray(data.daily)) return null
  if (typeof data.sessionTimestamps !== 'object' || data.sessionTimestamps === null) return null
  return data
}

function writeCache(workspaceId: string, cache: HeatmapCache): void {
  writeJsonFileAtomic(getCachePath(workspaceId), cache)
}

/**
 * 纯内存比较：缓存的 sessionTimestamps 是否与当前活跃会话的 updatedAt 一致。
 * 不一致 → 有会话被创建/归档/继续聊天 → 缓存失效。
 */
function isCacheValid(
  cache: HeatmapCache,
  activeSessions: Array<{ id: string; createdAt: number; updatedAt?: number }>,
): boolean {
  const cachedIds = Object.keys(cache.sessionTimestamps)
  if (cachedIds.length !== activeSessions.length) return false

  for (const session of activeSessions) {
    const currentTs = session.updatedAt ?? session.createdAt
    if (cache.sessionTimestamps[session.id] !== currentTs) return false
  }

  return true
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 获取工作区热力图每日 token 数据。
 * 用 sessionTimestamps 记录做缓存失效：任意会话 updatedAt 变化即重建。
 */
export function getWorkspaceHeatmapDaily(
  workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  const activeSessions = sessions.filter((s) => !s.archived)

  // 读缓存，sessionTimestamps 一致则直接返回
  const cache = readCache(workspaceId)
  if (cache && isCacheValid(cache, activeSessions)) {
    return cache.daily
  }

  // 重建
  const daily = buildWorkspaceTokenDaily(workspaceId, sessions)
  const sessionTimestamps: Record<string, number> = {}
  for (const s of activeSessions) {
    sessionTimestamps[s.id] = s.updatedAt ?? s.createdAt
  }
  writeCache(workspaceId, { version: CACHE_VERSION, sessionTimestamps, daily, cachedAt: Date.now() })
  return daily
}
