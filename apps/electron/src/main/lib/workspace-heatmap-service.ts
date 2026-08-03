/**
 * 工作区热力图 Token 聚合服务
 *
 * 扫描会话 JSONL 文件，按天聚合实际 Token 用量（输入、缓存读写与输出）。
 * 结果缓存到 ~/.profer/heatmap-cache/{workspaceId}.json。
 *
 * 缓存策略：按天增量快照（缓存只作「加速层」，不作为权威数据源）。
 *   — 缓存记录 lastSnapshotDate（最后一次快照到的本地日期）。
 *   — 无缓存 → 全量扫描建立初始缓存。
 *   — lastSnapshotDate < 今天 → 增量扫描 [lastSnapshotDate, 今天] 合并。
 *   — lastSnapshotDate === 今天 → 当天数据仍在增长，仍重扫 [今天, 今天] 合并，
 *     确保当天后续产生的 result 不会因旧实现直接 return 缓存而被永久丢弃。
 *   — 历史缺失缺口（脏缓存遗留）无法靠增量补齐，由上层删除脏缓存后重建一次。
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
 * 缓存策略（按天增量快照，缓存只作为「加速层」，不作为权威数据源）：
 *   1. 无缓存 → 全量扫描，建立初始缓存。
 *   2. lastSnapshotDate < 今天 → 增量扫描 [lastSnapshotDate, 今天] 合并进缓存。
 *      fromDate 从 lastSnapshotDate 当天开始（而非下一天），确保快照日当天后续
 *      产生的 result 也能被合并，不会因边界而被永久跳过。
 *   3. lastSnapshotDate === 今天 → 当天数据仍在持续增长，重扫 [今天, 今天] 合并，
 *      保证停留页面期间/当天后续的新 result 不会丢失。（旧实现此处直接 return 缓存，
 *      导致当天后续数据被永久丢弃）
 *
 * 历史数据缺口（如脏缓存遗留的丢失日期）无法靠增量补齐，应由上层删除脏缓存后重建一次。
 */
export function getWorkspaceHeatmapDaily(
  workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  const activeSessions = sessions.filter((s) => !s.archived)
  const today = todayDate()

  const cache = readCache(workspaceId)

  // ── 情况 1：无缓存（首次访问或版本淘汰），全量构建 ──
  if (!cache) {
    const daily = buildWorkspaceTokenDaily(workspaceId, sessions)
    writeCache(workspaceId, { version: CACHE_VERSION, lastSnapshotDate: today, daily, cachedAt: Date.now() })
    return daily
  }

  // ── 情况 2 & 3：从缓存的 lastSnapshotDate 当天一直合并到今天的增量 ──
  // fromDate 取 lastSnapshotDate 当天而不是 nextDay，避免快照日当天新数据被边界跳过。
  const fromDate = cache.lastSnapshotDate <= today ? cache.lastSnapshotDate : today
  const incremental = incrementalScan(activeSessions, fromDate, today)

  // 合并增量：对 fromDate 当天覆盖、其后日期累加（详见 mergeDaily）。
  const daily = mergeDaily(cache.daily, incremental, fromDate)

  writeCache(workspaceId, { version: CACHE_VERSION, lastSnapshotDate: today, daily, cachedAt: Date.now() })
  return daily
}

/**
 * 将增量扫描结果合并进已有 daily 数组（纯函数，便于单测）。
 *
 * 合并规则（含对漏算 bug 的修正逻辑）：
 *   - 对 fromDate 当天采用「覆盖」：缓存中该天的旧值以最近一次扫描为准，避免重复累计。
 *   - 对 fromDate 之后的日期采用「累加」：缓存本不该有这些天的记录，属增量补录。
 *
 * @returns 合并后按日期升序排列的 daily 数组（不修改入参）。
 */
export function mergeDaily(
  daily: HeatmapDailyEntry[],
  incremental: Map<string, number>,
  fromDate: string,
): HeatmapDailyEntry[] {
  const dailyMap = new Map<string, number>(daily.map((d) => [d.date, d.tokens]))
  for (const [date, tokens] of incremental) {
    if (date === fromDate) {
      dailyMap.set(date, tokens)
    } else {
      dailyMap.set(date, (dailyMap.get(date) ?? 0) + tokens)
    }
  }
  return Array.from(dailyMap.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
