/**
 * 工作区热力图 Token 聚合服务
 *
 * 扫描会话 JSONL 文件，按天聚合实际 Token 用量（输入、缓存读写与输出）。
 * 结果缓存到 ~/.profer/heatmap-cache/{workspaceId}.json。
 *
 * 缓存策略：按自然日结算（缓存只作「加速层」，不作为权威数据源）。
 *   — 缓存记录 lastFinalizedDate（最后一次已结算的本地日期）。
 *   — 无缓存 → 全量扫描，但只统计到昨天，绝不读取当天用量。
 *   — lastFinalizedDate < 昨天 → 只补算尚未结算的历史日期直到昨天。
 *   — lastFinalizedDate >= 昨天 → 直接返回缓存，当天后续访问零会话文件 I/O。
 *   — 用户连续多天未打开时，一次性补算缺失的完整日期区间。
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
export const CACHE_VERSION = 6

interface HeatmapCache {
  /** 缓存格式版本 */
  version: number
  /**
   * 最后一次已结算的本地日期（ISO "YYYY-MM-DD"）。
   * 该日期及之前的数据固定不再变化；当天永远不进入缓存。
   */
  lastFinalizedDate: string
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

/** 返回昨天的本地日期（ISO "YYYY-MM-DD"）。 */
function yesterdayDate(): string {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return timestampToLocalDate(yesterday.getTime())
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
 * 扫描工作区下仍保留 JSONL 的会话，按日聚合 token 用量；归档只影响列表展示，
 * 不影响已经发生的历史用量。
 * 返回按日期升序排列的条目列表（最近 365 天）。
 */
export function buildWorkspaceTokenDaily(
  _workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
  throughDate: string = yesterdayDate(),
): HeatmapDailyEntry[] {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 365)
  const cutoffDate = timestampToLocalDate(cutoff.getTime())

  const dayMap = new Map<string, number>()

  for (const session of sessions) {
    // 归档只是索引元数据变化，不代表历史用量消失；只要 JSONL 仍在就应计入。
    const sessionDays = extractSessionDailyTokens(session.id)
    for (const [date, tokens] of sessionDays) {
      if (date < cutoffDate || date > throughDate) continue
      dayMap.set(date, (dayMap.get(date) ?? 0) + tokens)
    }
  }

  return Array.from(dayMap.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 增量扫描：只扫描 fromDate 到 toDate 范围内、尚未结算日期的 token；归档会话也纳入，
 * 日期一旦结算，结果即固定，不再包含当天这种仍会增长的数据。
 */
function incrementalScan(
  sessions: Array<{ id: string; archived?: boolean }>,
  fromDate: string,
  toDate: string,
): Map<string, number> {
  const dayMap = new Map<string, number>()

  for (const session of sessions) {
    // 已结算日期的增量扫描也必须包含归档会话，避免归档造成历史缺口。
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
  if (typeof data.lastFinalizedDate !== 'string' || !data.lastFinalizedDate) return null
  return data
}

function writeCache(workspaceId: string, cache: HeatmapCache): void {
  writeJsonFileAtomic(getCachePath(workspaceId), cache)
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 获取工作区热力图每日 token 数据。
 *
 * 缓存策略（按天增量快照，缓存只作为「加速层」，不作为权威数据源）：
 *   1. 无缓存 → 全量扫描，建立初始缓存。
 *   2. lastSnapshotDate < 今天 → 增量扫描 [lastSnapshotDate, 今天] 合并进缓存。
 *      fromDate 从 lastSnapshotDate 当天开始（而非下一天），确保快照日当天后续
 *      产生的 result 也能被合并，不会因边界而被永久跳过。
 *   3. lastSnapshotDate === 今天 → 当天数据仍在持续增长，重扫 [今天, 今天] 合并，
 *      保证停留页面期间/当天后续的新 result 不会丢失。（旧实现此处直接 return 缓存，
 *      导致当天后续数据被永久丢弃）
 *
 * 历史数据缺口（如脏缓存遗留的丢失日期）无法靠增量补齐，因此版本 6
 * 会用仍保留的会话 JSONL 做一次全量恢复；之后历史日期不再因归档变化。
 */
export function getWorkspaceHeatmapDaily(
  workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  // 归档不会改变已发生的 Token 用量；只要会话 JSONL 尚存，就纳入历史统计。
  const selectedSessions = sessions
  const yesterday = yesterdayDate()
  const cache = readCache(workspaceId)

  // No cache: build history once, explicitly excluding today.
  if (!cache) {
    const daily = buildWorkspaceTokenDaily(workspaceId, selectedSessions, yesterday)
    writeCache(workspaceId, { version: CACHE_VERSION, lastFinalizedDate: yesterday, daily, cachedAt: Date.now() })
    return daily
  }

  // Crossed one or more local dates: finalize all missing dates through yesterday.
  if (cache.lastFinalizedDate < yesterday) {
    const fromDate = nextDay(cache.lastFinalizedDate)
    const incremental = incrementalScan(selectedSessions, fromDate, yesterday)
    const daily = mergeDaily(cache.daily, incremental)
    writeCache(workspaceId, { version: CACHE_VERSION, lastFinalizedDate: yesterday, daily, cachedAt: Date.now() })
    return daily
  }

  // Same day: return fixed values without touching any session JSONL file.
  return cache.daily
}

/** Return the next local calendar date for an ISO date string. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return timestampToLocalDate(d.getTime())
}

/**
 * Merge finalized daily values into the cache (pure function for unit tests).
 * Values are replaced rather than added so a retry cannot double-count a date.
 */
export function mergeDaily(
  daily: HeatmapDailyEntry[],
  incremental: Map<string, number>,
): HeatmapDailyEntry[] {
  const dailyMap = new Map<string, number>(daily.map((d) => [d.date, d.tokens]))
  for (const [date, tokens] of incremental) {
    dailyMap.set(date, tokens)
  }
  return Array.from(dailyMap.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
