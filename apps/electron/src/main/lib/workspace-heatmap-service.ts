/**
 * 工作区热力图 Token 聚合服务
 *
 * 扫描会话 JSONL 文件，按天聚合实际 Token 用量（输入、缓存读写与输出）。
 * 结果缓存到 ~/.profer/heatmap-cache/{workspaceId}.json。
 *
 * 缓存策略：按天增量快照。
 *   — 缓存记录 lastSnapshotDate（最后一次快照到的本地日期）。
 *   — 如果 lastSnapshotDate === 今天 → 缓存有效，零 I/O 直接返回。
 *   — 如果 lastSnapshotDate < 今天 → 只扫描昨天和今天的 result 做增量追加。
 *   — 历史日期的数据永不重建：昨天的 token 用量不会因为今天继续聊天而改变。
 *
 * 数据来源：每个会话 JSONL 中 **所有** type=result 消息的 usage 字段。
 * 统计口径：input + cache read + cache creation + output；缺失字段按 0 处理。
 * 日期归属：每条 result 消息按自身的 _createdAt 和本机时区归入对应自然日。
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
export const CACHE_VERSION = 4

interface HeatmapCache {
  /** 缓存格式版本 */
  version: number
  /**
   * 最后一次快照覆盖到的本地日期（ISO "YYYY-MM-DD"）。
   * 如果 === 今天 → 缓存有效；如果 < 今天 → 只需增量扫描昨天和今天。
   */
  lastSnapshotDate: string
  /** 缓存时间戳 */
  cachedAt: number
  /** 按天聚合的 token 数据，按日期升序 */
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

/** 返回今天的本地日期（ISO "YYYY-MM-DD"）。 */
function todayDate(): string {
  return timestampToLocalDate(Date.now())
}

// ── JSONL 读取 ────────────────────────────────────────────

/**
 * 逐条解析会话 JSONL 中所有 type=result 消息，
 * 按每条消息的 _createdAt 日期汇总当日 token 消耗。
 *
 * 返回 Map<date, tokens>，key 为 ISO 日期 "YYYY-MM-DD"。
 * 文件不存在或无合法 result 消息时返回空 Map。
 */
export function usageToTotalTokens(usage: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}): number {
  return (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
}

/** 将时间戳格式化为运行 Profer 的设备所在时区的自然日。 */
export function timestampToLocalDate(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 从会话 JSONL 中提取指定日期范围内的每日 token 聚合。
 * 与全量 extract 相同逻辑，但只收集 date >= fromDate 且 date <= toDate 的条目。
 */
function extractSessionDailyTokensInRange(
  sessionId: string,
  fromDate: string,
  toDate: string,
): Map<string, number> {
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
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
      _createdAt?: number
    }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (parsed.type === 'result' && parsed.usage && parsed._createdAt) {
      const date = timestampToLocalDate(parsed._createdAt)
      // 只收集范围内的日期
      if (date < fromDate || date > toDate) continue

      const tokens = usageToTotalTokens(parsed.usage)
      if (tokens > 0) {
        dayMap.set(date, (dayMap.get(date) ?? 0) + tokens)
      }
    }
  }

  return dayMap
}

/**
 * 全量提取会话 JSONL 中所有日期的 token（用于首次构建缓存）。
 * 与 extractSessionDailyTokensInRange 逻辑一致但无日期过滤。
 */
function extractSessionDailyTokens(sessionId: string): Map<string, number> {
  return extractSessionDailyTokensInRange(sessionId, '0000-00-00', '9999-99-99')
}

// ── 聚合 ──────────────────────────────────────────────────

/**
 * 扫描工作区下所有非归档会话，按日聚合 token 用量。
 * 返回按日期升序排列的条目列表（最近 365 天）。
 */
export function buildWorkspaceTokenDaily(
  _workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 365)
  const cutoffDate = timestampToLocalDate(cutoff.getTime())

  const dayMap = new Map<string, number>()

  for (const session of sessions) {
    if (session.archived) continue
    const sessionDays = extractSessionDailyTokens(session.id)
    for (const [date, tokens] of sessionDays) {
      if (date < cutoffDate) continue
      dayMap.set(date, (dayMap.get(date) ?? 0) + tokens)
    }
  }

  return Array.from(dayMap.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 增量扫描：只扫描 fromDate 到 toDate 范围内、缓存中尚未覆盖的日期的 token。
 * 将新数据合并进已有 daily 数组。
 */
function incrementalScan(
  sessions: Array<{ id: string; archived?: boolean }>,
  fromDate: string,
  toDate: string,
): Map<string, number> {
  const dayMap = new Map<string, number>()

  for (const session of sessions) {
    if (session.archived) continue
    const sessionDays = extractSessionDailyTokensInRange(session.id, fromDate, toDate)
    for (const [date, tokens] of sessionDays) {
      dayMap.set(date, (dayMap.get(date) ?? 0) + tokens)
    }
  }

  return dayMap
}

// ── 缓存读写 ──────────────────────────────────────────────

function readCache(workspaceId: string): HeatmapCache | null {
  const path = getCachePath(workspaceId)
  const data = readJsonFileSafe<HeatmapCache>(path)
  if (!data) return null
  // 版本不匹配 → 淘汰
  if (data.version !== CACHE_VERSION) return null
  if (!Array.isArray(data.daily)) return null
  if (typeof data.lastSnapshotDate !== 'string' || !data.lastSnapshotDate) return null
  return data
}

function writeCache(workspaceId: string, cache: HeatmapCache): void {
  writeJsonFileAtomic(getCachePath(workspaceId), cache)
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 获取工作区热力图每日 token 数据。
 *
 * 缓存策略（按天增量快照）：
 *   1. 缓存命中（lastSnapshotDate === 今天）→ 直接返回，零 I/O。
 *   2. 有缓存但 lastSnapshotDate < 今天 → 只扫描 [昨天, 今天] 的增量。
 *   3. 无缓存 → 全量扫描，建立初始缓存。
 */
export function getWorkspaceHeatmapDaily(
  workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  const activeSessions = sessions.filter((s) => !s.archived)
  const today = todayDate()

  const cache = readCache(workspaceId)

  // ── 情况 1：缓存已覆盖今天，零 I/O 直接返回 ──
  if (cache && cache.lastSnapshotDate === today) {
    return cache.daily
  }

  // ── 情况 2：有缓存但需要增量更新 ──
  if (cache && cache.lastSnapshotDate < today) {
    // 扫描从 lastSnapshotDate 后一天到今天的增量
    const fromDate = nextDay(cache.lastSnapshotDate)
    const incremental = incrementalScan(activeSessions, fromDate, today)

    if (incremental.size > 0) {
      // 合并：把增量数据并入 daily 数组
      const dailyMap = new Map<string, number>(cache.daily.map((d) => [d.date, d.tokens]))
      for (const [date, tokens] of incremental) {
        dailyMap.set(date, (dailyMap.get(date) ?? 0) + tokens)
      }
      const daily = Array.from(dailyMap.entries())
        .map(([date, tokens]) => ({ date, tokens }))
        .sort((a, b) => a.date.localeCompare(b.date))

      writeCache(workspaceId, { version: CACHE_VERSION, lastSnapshotDate: today, daily, cachedAt: Date.now() })
      return daily
    }

    // 增量扫描无新数据，只更新 lastSnapshotDate 避免重复扫描
    writeCache(workspaceId, { ...cache, lastSnapshotDate: today, cachedAt: Date.now() })
    return cache.daily
  }

  // ── 情况 3：无缓存（首次访问或版本淘汰），全量构建 ──
  const daily = buildWorkspaceTokenDaily(workspaceId, sessions)
  writeCache(workspaceId, { version: CACHE_VERSION, lastSnapshotDate: today, daily, cachedAt: Date.now() })
  return daily
}

/** 返回 ISO 日期 "YYYY-MM-DD" 的下一天。 */
function nextDay(date: string): string {
  const d = new Date(date + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return timestampToLocalDate(d.getTime())
}
