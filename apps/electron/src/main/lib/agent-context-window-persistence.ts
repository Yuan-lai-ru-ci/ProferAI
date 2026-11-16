/**
 * 「最后已知上下文窗口」的轻量持久化。
 *
 * 为什么需要它：
 * - `context_window` 是 run 启动时发出的一次性事件，手机端经常恰好不在线而错过；
 * - 运行时快照（`AgentRuntimeContextStore`）在 `run_idle` 时清空，`get_agent_runtime_contexts`
 *   过去的过滤条件又只认 active 会话 —— 于是「跑完一轮后刷新页面」永远拿不到窗口大小，
 *   信息条一直显示「未知名」。
 *
 * 窗口大小是**模型属性**（同一会话同一模型基本稳定），跑完一轮后依然有效，
 * 所以按会话记住最后一次上报值。这里只存 token 数字，不存路径、提示词或任何用户内容。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-root'

export interface PersistedContextWindow {
  sessionId: string
  contextWindow: number
  updatedAt: number
}

/** 防止文件无限增长：只保留最近使用的若干会话 */
const MAX_ENTRIES = 500

let cache: Map<string, PersistedContextWindow> | null = null

function storePath(): string {
  return join(getConfigDir(), 'agent-context-windows.json')
}

function load(): Map<string, PersistedContextWindow> {
  if (cache) return cache
  const loaded = new Map<string, PersistedContextWindow>()
  cache = loaded
  try {
    const path = storePath()
    if (!existsSync(path)) return loaded
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) return loaded
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const sessionId = entry.sessionId
      const contextWindow = entry.contextWindow
      const updatedAt = entry.updatedAt
      if (typeof sessionId !== 'string' || !sessionId) continue
      if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) continue
      loaded.set(sessionId, {
        sessionId,
        contextWindow: Math.round(contextWindow),
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
      })
    }
  } catch {
    // 文件损坏 / 读取失败：当成没有记录，下次成功上报会覆盖它
  }
  return loaded
}

function flush(entries: Map<string, PersistedContextWindow>): void {
  try {
    const list = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES)
    writeFileSync(storePath(), `${JSON.stringify(list, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.warn('[上下文窗口] 持久化失败（不影响本轮运行）:', error)
  }
}

/** 记录一次窗口上报。同一会话保留最后一次值。 */
export function persistContextWindow(sessionId: string, contextWindow: number): void {
  if (!sessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) return
  const entries = load()
  const previous = entries.get(sessionId)
  if (previous && previous.contextWindow === Math.round(contextWindow)) return
  entries.set(sessionId, { sessionId, contextWindow: Math.round(contextWindow), updatedAt: Date.now() })
  flush(entries)
}

/** 读单个会话最后已知的窗口大小 */
export function readPersistedContextWindow(sessionId: string): number | null {
  const entry = load().get(sessionId)
  return entry ? entry.contextWindow : null
}

/**
 * 列出已知窗口，可按需限定会话集合。
 * 与运行时快照合并时以运行时快照为准（它更新）。
 */
export function listPersistedContextWindows(sessionIds?: readonly string[]): PersistedContextWindow[] {
  const all = [...load().values()]
  if (!sessionIds) return all
  const allowed = new Set(sessionIds)
  return all.filter((entry) => allowed.has(entry.sessionId))
}

/** 会话删除时清掉对应记录（也防止长期积累） */
export function deletePersistedContextWindow(sessionId: string): void {
  const entries = load()
  if (!entries.delete(sessionId)) return
  flush(entries)
}
