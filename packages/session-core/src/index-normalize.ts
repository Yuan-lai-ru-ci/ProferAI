/**
 * 会话索引（agent-sessions.json）的格式归一。纯函数，无文件 IO，浏览器安全。
 *
 * 主进程（读取后按需回写清理）与 profer CLI（只读）共用这里，避免两边对同一份文件给出不同结果。
 * 读盘、缓存与回写仍由各自的调用方负责。
 */
import type { AgentSessionMeta } from '@profer/shared'
import { normalizeAgentRuntime } from '@profer/shared'

export interface SessionIndexData {
  version: number
  sessions: AgentSessionMeta[]
}

export interface NormalizedSessionIndex {
  index: SessionIndexData
  /** 是否清理了下线前遗留的知识库引用字段；主进程据此决定是否回写磁盘 */
  removedLegacyKnowledgeReferences: boolean
}

/** 索引文件缺失或损坏时的空索引版本号 */
const EMPTY_INDEX_VERSION = 1

function normalizeSessionRuntime(session: AgentSessionMeta): AgentSessionMeta {
  const agentRuntime = normalizeAgentRuntime(session.agentRuntime)
  return session.agentRuntime === agentRuntime ? session : { ...session, agentRuntime }
}

function removeLegacyKnowledgeReferences(session: AgentSessionMeta): AgentSessionMeta {
  if (!Object.prototype.hasOwnProperty.call(session, 'knowledgeReferences')) return session
  const { knowledgeReferences: _removed, ...withoutKnowledgeReferences } = session as AgentSessionMeta & { knowledgeReferences?: unknown }
  return withoutKnowledgeReferences
}

/**
 * 归一一份已解析的索引数据。
 * `data` 为 null 表示文件缺失或损坏，返回空索引且不报告清理。
 * 未涉及的会话对象保持同一引用，便于调用方用 `===` 判断是否变化。
 */
export function normalizeSessionIndexData(data: SessionIndexData | null): NormalizedSessionIndex {
  if (!data) {
    return { index: { version: EMPTY_INDEX_VERSION, sessions: [] }, removedLegacyKnowledgeReferences: false }
  }

  let removedLegacyKnowledgeReferences = false
  const sessions = Array.isArray(data.sessions)
    ? data.sessions.map((session) => {
        const normalized = normalizeSessionRuntime(session)
        const cleaned = removeLegacyKnowledgeReferences(normalized)
        if (cleaned !== normalized) removedLegacyKnowledgeReferences = true
        return cleaned
      })
    : []

  return { index: { ...data, sessions }, removedLegacyKnowledgeReferences }
}
