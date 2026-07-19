import type { AgentSessionMeta, KnowledgeReference } from '@profer/shared'
import { resolveKnowledgeReferences } from './knowledge-item-service'

export interface AgentKnowledgeReferenceDeps {
  getSession(sessionId: string): AgentSessionMeta | undefined
  updateSession(sessionId: string, patch: { knowledgeReferences: KnowledgeReference[] }): AgentSessionMeta
}

/**
 * 将资料引用写入 Agent session metadata，作为 MCP 读取工具唯一的持久化 allowlist。
 * 不把资料目录放入 additionalDirectories，也不把全文写进 Agent prompt。
 */
export function getKnowledgeReferencesForAgentSession(sessionId: string, deps: Pick<AgentKnowledgeReferenceDeps, 'getSession'>): KnowledgeReference[] {
  const session = deps.getSession(sessionId)
  if (!session) throw new Error('Agent 会话不存在')
  return session.knowledgeReferences || []
}

export function removeKnowledgeReferenceFromAgentSession(
  sessionId: string,
  itemId: string,
  deps: AgentKnowledgeReferenceDeps,
): KnowledgeReference[] {
  const session = deps.getSession(sessionId)
  if (!session) throw new Error('Agent 会话不存在')
  const current = session.knowledgeReferences || []
  const references = current.filter((reference) => reference.itemId !== itemId)
  if (references.length === current.length) throw new Error('该资料未导入当前 Agent 会话')
  deps.updateSession(sessionId, { knowledgeReferences: references })
  return references
}

export function addKnowledgeReferencesToAgentSession(
  sessionId: string,
  itemIds: string[],
  deps: AgentKnowledgeReferenceDeps,
): KnowledgeReference[] {
  const session = deps.getSession(sessionId)
  if (!session) throw new Error('Agent 会话不存在')

  const incoming = resolveKnowledgeReferences(itemIds)
  const merged = new Map<string, KnowledgeReference>()
  for (const reference of session.knowledgeReferences || []) merged.set(reference.itemId, reference)
  for (const reference of incoming) merged.set(reference.itemId, reference)
  const references = [...merged.values()]
  if (references.length > 10) throw new Error('一个 Agent 会话最多导入 10 份资料')

  deps.updateSession(sessionId, { knowledgeReferences: references })
  return references
}
