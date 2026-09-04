import type { ChatMessage, FileAttachment, KnowledgeReference } from '@profer/shared'
import { buildChatKnowledgeContext, type KnowledgeSearchPort } from './chat-knowledge-context'

export interface PrepareChatKnowledgeRequestInput {
  userMessage: string
  attachments?: FileAttachment[]
  history: ChatMessage[]
  currentReferences?: KnowledgeReference[]
}

export interface PreparedChatKnowledgeRequest {
  providerUserMessage: string
  effectiveReferences: KnowledgeReference[]
  knowledgeContextChars: number
}

export interface ChatKnowledgeRequestDeps {
  enrichMessage: (message: string, attachments?: FileAttachment[]) => Promise<string>
  search: KnowledgeSearchPort
}

/**
 * 生成实际交给 provider 的本轮用户内容。
 * 原始用户问题和资料引用仍由调用方独立持久化；这里仅负责受控上下文拼接。
 */
export async function prepareChatKnowledgeRequest(
  input: PrepareChatKnowledgeRequestInput,
  deps: ChatKnowledgeRequestDeps,
): Promise<PreparedChatKnowledgeRequest> {
  const unique = new Map<string, KnowledgeReference>()
  for (const message of input.history) {
    for (const reference of message.knowledgeReferences || []) unique.set(reference.itemId, reference)
  }
  for (const reference of input.currentReferences || []) unique.set(reference.itemId, reference)
  const effectiveReferences = [...unique.values()]
  const documentEnhancedMessage = await deps.enrichMessage(input.userMessage, input.attachments)
  const knowledgeContext = await buildChatKnowledgeContext(documentEnhancedMessage, effectiveReferences, deps.search)
  return {
    providerUserMessage: documentEnhancedMessage + knowledgeContext,
    effectiveReferences,
    knowledgeContextChars: knowledgeContext.length,
  }
}
