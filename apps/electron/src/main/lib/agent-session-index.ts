import { statSync } from 'node:fs'
import type { AgentSessionMeta } from '@profer/shared'
import { normalizeAgentRuntime } from '@profer/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export interface AgentSessionsIndex {
  version: number
  sessions: AgentSessionMeta[]
}

export interface AgentSessionIndexStore {
  read: () => AgentSessionsIndex
  write: (index: AgentSessionsIndex) => void
  list: (includeArchived?: boolean) => AgentSessionMeta[]
  countArchived: () => number
  get: (id: string) => AgentSessionMeta | undefined
}

const INDEX_VERSION = 1

interface IndexCache {
  data: AgentSessionsIndex
  mtimeMs: number
  size: number
}

/**
 * 本地 Agent 会话索引的存储边界。
 *
 * 这里只负责 agent-sessions.json 的磁盘恢复、缓存、兼容归一化和基础查询；
 * 消息 JSONL、会话工作目录、fork/rewind 与 Agent 运行时都留在上层。
 */
export function createAgentSessionIndexStore(getPath: () => string): AgentSessionIndexStore {
  let cache: IndexCache | null = null

  const cacheIndex = (data: AgentSessionsIndex): void => {
    try {
      const stat = statSync(getPath())
      cache = { data, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      // 无法确认磁盘版本时绝不复用内存数据，交给下次读取走恢复路径。
      cache = null
    }
  }

  const normalizeSessionRuntime = (session: AgentSessionMeta): AgentSessionMeta => {
    const agentRuntime = normalizeAgentRuntime(session.agentRuntime)
    return session.agentRuntime === agentRuntime ? session : { ...session, agentRuntime }
  }

  const removeLegacyAgentKnowledgeReferences = (session: AgentSessionMeta): AgentSessionMeta => {
    if (!Object.prototype.hasOwnProperty.call(session, 'knowledgeReferences')) return session
    const { knowledgeReferences: _removed, ...withoutKnowledgeReferences } = session as AgentSessionMeta & { knowledgeReferences?: unknown }
    return withoutKnowledgeReferences
  }

  const read = (): AgentSessionsIndex => {
    if (cache) {
      try {
        const stat = statSync(getPath())
        if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.data
      } catch {
        cache = null
      }
    }

    const data = readJsonFileSafe<AgentSessionsIndex>(getPath())
    if (!data) return { version: INDEX_VERSION, sessions: [] }

    let removedLegacyKnowledgeReferences = false
    const sessions = Array.isArray(data.sessions)
      ? data.sessions.map((session) => {
          const normalized = normalizeSessionRuntime(session)
          const cleaned = removeLegacyAgentKnowledgeReferences(normalized)
          if (cleaned !== normalized) removedLegacyKnowledgeReferences = true
          return cleaned
        })
      : []
    const normalized: AgentSessionsIndex = { ...data, sessions }
    let cacheNormalized = true
    if (removedLegacyKnowledgeReferences) {
      try {
        writeJsonFileAtomic(getPath(), normalized)
        console.info('[Agent 会话] 已清理下线前遗留的知识库引用字段')
      } catch (error) {
        cacheNormalized = false
        console.warn('[Agent 会话] 清理遗留知识库引用字段失败，将在下次读取时重试:', error)
      }
    }
    if (cacheNormalized) cacheIndex(normalized)
    return normalized
  }

  const write = (index: AgentSessionsIndex): void => {
    try {
      writeJsonFileAtomic(getPath(), index)
      cacheIndex(index)
    } catch (error) {
      // 调用方可能已原地修改缓存对象；写入失败后不能继续返回未落盘数据。
      cache = null
      console.error('[Agent 会话] 写入索引文件失败:', error)
      throw new Error('写入 Agent 会话索引失败')
    }
  }

  const list = (includeArchived = false): AgentSessionMeta[] => {
    // filter 已创建新数组，排序不改变缓存中的索引顺序。
    return read().sessions
      .filter((session) => includeArchived || !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const countArchived = (): number => {
    let count = 0
    for (const session of read().sessions) {
      if (session.archived && !session.draft) count += 1
    }
    return count
  }

  return {
    read,
    write,
    list,
    countArchived,
    get: (id) => read().sessions.find((session) => session.id === id),
  }
}
