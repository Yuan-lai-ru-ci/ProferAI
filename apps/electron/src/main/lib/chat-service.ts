/** 桌面宿主装配：完整 Chat 编排由共享 runtime 执行。 */
import type { WebContents } from 'electron'
import type { ChatSendInput } from '@profer/shared'
import { pushChatStream } from './chat-stream-bus'
import { routePluginModel } from './plugins/plugin-routing'
import { resolveEditionBearerToken } from '@profer/edition-contract'
import { listChannels, decryptApiKey } from './channel-manager'
import { appendBranchTail, updateConversationMeta, getConversationBranch, getConversationMeta, DEFAULT_CONVERSATION_TITLE } from './conversation-manager'
import { readAttachmentAsBase64, isImageAttachment } from './attachment-service'
import { extractTextFromAttachment, isDocumentAttachment } from './document-parser'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getEnabledTools } from './chat-tool-registry'
import { executeToolCalls } from './chat-tool-executor'
import { editionProviders } from './edition'
import { searchKnowledgeItemsForChat } from './knowledge-item-service'
import { prepareChatKnowledgeRequest } from './chat-knowledge-request'
import { normalizeChatStreamError } from './chat-error-utils'
import { createChatRuntime } from '@profer/core'
import type { ChatRuntimePorts } from '@profer/core'
import * as titlePolicy from './title-generation'
import { channelStore } from './channel-manager'

export type { AutoTitleConversationInput } from '@profer/core'
const targets = new Map<string, WebContents | null>()
const runtime = createChatRuntime({
  emit: (conversationId, channel, payload) => pushChatStream(targets.get(`${conversationId}:${typeof payload === 'object' && payload !== null && 'runId' in payload ? String(payload.runId) : ''}`) ?? null, conversationId, channel, payload),
  routePluginModel, listChannels, decryptApiKey, readAttachmentAsBase64, isImageAttachment,
  extractTextFromAttachment, isDocumentAttachment, getFetchFn, getEffectiveProxyUrl, getEnabledTools,
  executeToolCalls: (calls, context) => executeToolCalls(calls, { ...context, webContents: targets.get(`${context.conversationId}:${context.runId}`) ?? null }),
  editionProviders, searchKnowledgeItemsForChat, prepareChatKnowledgeRequest, normalizeChatStreamError,
  resolveEditionBearerToken, titlePolicy,
  conversations: { appendBranchTail, updateConversationMeta, getConversationBranch, getConversationMeta, DEFAULT_CONVERSATION_TITLE },
  syncRecoveredChannels: async (baseUrl, token) => { await editionProviders.channels.syncFromServer?.(channelStore, baseUrl, token) },
} satisfies ChatRuntimePorts)

export async function sendMessage(input: ChatSendInput, webContents: WebContents | null): Promise<void> {
  const key = `${input.conversationId}:${input.runId}`
  targets.set(key, webContents)
  try { await runtime.sendMessage(input) } finally { targets.delete(key) }
}
export const { stopGeneration, stopAllGenerations, generateTitle, autoTitleConversation, regenerateConversationTitle } = runtime
