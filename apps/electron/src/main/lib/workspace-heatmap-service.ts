/**
 * 工作区热力图 Token 聚合服务
 *
 * 扫描会话 JSONL 文件，按天聚合 token 消耗（input + output）。
 * 结果缓存到 ~/.profer/heatmap-cache/{workspaceId}.json，
 * 任意会话的 updatedAt 变化时自动重建缓存。
 *
 * 数据来源：每个会话 JSONL 最后一条 SDKResultMessage 的 usage 字段。
 * 日期归属：result 消息的 _createdAt > session.updatedAt > session.createdAt。
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

/** 单会话 token 提取结果 */
interface SessionTokenData {
  /** token 总量（input + output） */
  tokens: number
  /** result 消息的 _createdAt 时间戳，0 表示不可用 */
  lastActiveAt: number
}

interface HeatmapCache {
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
 * 从会话 JSONL 尾部反向扫描最后一条 type=result 消息。
 * 返回 token 总量及该消息的 _createdAt 时间戳。
 * 文件不存在或无合法 result 消息时返回 null。
 */
function extractSessionTokenData(sessionId: string): SessionTokenData | null {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return null

  let lines: string[]
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n')
  } catch {
    return null
  }

  // 从尾部反向扫，找到第一条 type=result 的消息
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
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

    if (parsed.type === 'result' && parsed.usage) {
      return {
        tokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
        lastActiveAt: parsed._createdAt ?? 0,
      }
    }
  }

  return null
}

// ── 聚合 ──────────────────────────────────────────────────

/**
 * 扫描工作区下所有非归档会话，按实际活跃日期聚合每日 token 消耗。
 * 日期优先级：result 消息 _createdAt > session.updatedAt > session.createdAt。
 * 返回按日期升序排列的条目列表（最近 365 天）。
 */
export function buildWorkspaceTokenDaily(
  workspaceId: string,
  sessions: Array<{ id: string; createdAt: number; updatedAt?: number; archived?: boolean }>,
): HeatmapDailyEntry[] {
  const now = new Date()
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 365)

  const dayMap = new Map<string, number>()

  for (const session of sessions) {
    if (session.archived) continue

    const tokenData = extractSessionTokenData(session.id)
    if (!tokenData || tokenData.tokens <= 0) continue

    // 日期优先级：result._createdAt > updatedAt > createdAt
    const activeAt =
      tokenData.lastActiveAt > 0
        ? tokenData.lastActiveAt
        : (session.updatedAt ?? session.createdAt)

    const attributionDate = new Date(activeAt)
    if (attributionDate < cutoff) continue

    const date = attributionDate.toISOString().slice(0, 10)
    dayMap.set(date, (dayMap.get(date) ?? 0) + tokenData.tokens)
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
  writeCache(workspaceId, { sessionTimestamps, daily, cachedAt: Date.now() })
  return daily
}
