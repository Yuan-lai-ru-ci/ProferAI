import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_IPC_CHANNELS as C, isChannelEnabledForChat } from '@profer/shared'
import type { Channel, ChatSendInput, AttachmentSaveInput } from '@profer/shared'
import { getAdapter } from '../../../packages/core/src/providers/index'
import { createChatRuntime } from '../../../packages/core/src/chat-runtime'
import { createConversationStore, DEFAULT_CONVERSATION_TITLE } from '../../../packages/session-store/src/conversation-store'
import * as titlePolicy from '@profer/agent-runtime/session-title-policy'
import type { CoreAccountService } from './account-service'
import type { CoreChannelConfig } from './config'
import { assertChatId, createCoreChatAttachments } from './chat-attachments'

declare const __PROFER_BUILD_TARGET__: 'oss' | 'commercial'

export interface CoreChatOptions {
  account?: CoreAccountService
  defaultSelection?: () => { channelId?: string; modelId?: string }
  configDir: string
  listChannels(): CoreChannelConfig[]
  emit(conversationId: string, channel: string, payload: unknown): void
  fetch?: typeof globalThis.fetch
}
export function createCoreChat(options: CoreChatOptions) {
  const dir = join(options.configDir, 'conversations')
  mkdirSync(dir, { recursive: true })
  // 删除JSONL时不猜测附件归属；仅显式delete-attachment可删除安全校验后的单个附件。
  const assertIndexVersion = () => {
    for (const suffix of ['', '.tmp', '.bak']) {
      const path = join(options.configDir, `conversations.json${suffix}`)
      if (!existsSync(path)) continue
      let value: unknown
      try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
      if (value && typeof value === 'object' && 'version' in value && value.version !== 1) throw new Error('Chat索引版本不受支持，拒绝读取或覆盖')
    }
  }
  const store = createConversationStore({
    assertWritable: assertIndexVersion,
    getConversationsIndexPath: () => join(options.configDir, 'conversations.json'),
    getConversationsDir: () => dir,
    getConversationMessagesPath: (id: string) => { assertChatId(id); return join(dir, `${id}.jsonl`) },
    getConversationDiscardedPath: (id: string) => { assertChatId(id); return join(dir, `${id}.discarded.jsonl`) },
    deleteConversationAttachments: () => {}, deleteAttachment: () => {},
  })
  const attachments = createCoreChatAttachments(options.configDir, id => Boolean(store.getConversationMeta(id)))
  const channels = (): Channel[] => options.listChannels().map(channel => ({ ...channel, baseUrl: channel.baseUrl ?? '', enabled: channel.enabled ?? true, models: channel.models ?? [], createdAt: 0, updatedAt: 0 }))
  const unsupported = (): never => { throw new Error('Core Chat未装配桌面工具、插件、知识库或系统对话框能力') }
  const engine = createChatRuntime({
    emit: options.emit, conversations: { ...store, DEFAULT_CONVERSATION_TITLE }, titlePolicy,
    routePluginModel: (_key, input) => input,
    listChannels: channels,
    decryptApiKey: id => { const channel = options.listChannels().find(item => item.id === id); if (!channel) throw new Error('渠道不存在'); return channel.apiKey },
    readAttachmentAsBase64: attachments.readBase64,
    isImageAttachment: type => type.startsWith('image/'), isDocumentAttachment: type => !type.startsWith('image/'),
    extractTextFromAttachment: attachments.extractText,
    getEffectiveProxyUrl: async () => undefined, getFetchFn: () => options.fetch ?? globalThis.fetch,
    getEnabledTools: ids => { if (ids?.length) unsupported(); return { tools: [] } }, executeToolCalls: async () => unsupported(),
    editionProviders: typeof __PROFER_BUILD_TARGET__ !== 'undefined' && __PROFER_BUILD_TARGET__ === 'oss'
      ? { credentials: { shouldUseManagedRoute: () => false, managedPath: () => { throw new Error('开源版不提供代管渠道') } }, account: { getSession: async () => null, recoverSession: async () => null }, errors: { detectInsufficientCredits: () => null } }
      : { credentials: { shouldUseManagedRoute: channel => channel.serverManaged === true && !channel.directDataPlane, managedPath: kind => kind === 'messages' ? '/v1/proxy/messages' : '/v1/proxy/chat' }, account: { getSession: async () => await options.account?.operation('teamAuth') as never ?? null, recoverSession: async () => { await options.account?.refresh(); return await options.account?.operation('teamAuth') as never ?? null } }, errors: { detectInsufficientCredits: () => null } },
    syncRecoveredChannels: async () => {}, resolveEditionBearerToken: auth => auth.proxyToken || auth.token, searchKnowledgeItemsForChat: async () => unsupported(),
    prepareChatKnowledgeRequest: async (input, deps) => { if (input.currentReferences?.length || input.history.some(message => message.knowledgeReferences?.length)) unsupported(); return { providerUserMessage: await deps.enrichMessage(input.userMessage, input.attachments), effectiveReferences: [], knowledgeContextChars: 0 } },
    normalizeChatStreamError: (_provider, error) => ({ message: error instanceof Error ? error.message : String(error) }),
  })
  const active = new Map<string, { runId: string; promise: Promise<void> }>()
  let closed = false
  const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 1_000_000) throw new Error('Chat文本参数无效'); return value }
  const defaults = () => options.defaultSelection?.() ?? {}
  const id = (value: unknown): string => { assertChatId(value); if (!store.getConversationMeta(value)) throw new Error('Chat对话不存在'); return value }
  const model = (channelId: unknown, modelId: unknown) => {
    const channel = channels().find(item => item.id === channelId)
    if (!channel || !isChannelEnabledForChat(channel) || !channel.models.some(item => item.id === modelId && item.enabled) || channel.credentialMode === 'oauth') throw new Error('Chat渠道或模型不可用；不会自动回退')
    getAdapter(channel.provider, channel.apiProtocol, channel.baseUrl)
    if (!channel.apiKey && channel.provider !== 'ollama') throw new Error('Chat渠道缺少API Key')
  }
  const files = (value: unknown, conversationId: string) => {
    if (value === undefined) return
    if (!Array.isArray(value) || value.length > 20) throw new Error('Chat附件参数无效')
    for (const file of value) {
      if (!file || typeof file !== 'object' || typeof file.localPath !== 'string' || !file.localPath.startsWith(`${conversationId}/`) || typeof file.mediaType !== 'string' || !/^(image\/(png|jpeg|gif|webp)|text\/|application\/(json|xml))/.test(file.mediaType)) throw new Error('Chat附件归属或类型无效')
      if (typeof file.id !== 'string' || typeof file.filename !== 'string' || !file.filename || typeof file.size !== 'number' || !Number.isInteger(file.size) || file.size < 0) throw new Error('Chat附件元数据无效')
      attachments.validate(file.localPath)
    }
  }
  async function operation(operation: string, args: unknown[]): Promise<unknown> {
    if (closed) throw new Error('Core Chat正在关闭')
    if (!Array.isArray(args) || args.length > 5) throw new Error('Chat参数无效')
    assertIndexVersion()
    // JSON数组中的undefined会编码为null；只还原契约声明的可选位置。
    const optionalSlots: Record<string, number[]> = { [C.CREATE_CONVERSATION]: [0, 1, 2], [C.LIST_CONVERSATIONS]: [0], [C.UPDATE_MODEL]: [1, 2], [C.REGENERATE_TITLE]: [1, 2], [C.TRUNCATE_MESSAGES_FROM]: [2] }
    const normalized = args.map((value, index) => value === null && optionalSlots[operation]?.includes(index) ? undefined : value)
    const [a, b, c] = normalized
    switch (operation) {
      case C.LIST_CONVERSATIONS: if (a !== undefined && typeof a !== 'boolean') throw new Error('Chat归档参数无效'); return store.listConversations(a ?? false)
      case C.CREATE_CONVERSATION: if (b !== undefined || c !== undefined) model(c ?? defaults().channelId, b ?? defaults().modelId); return store.createConversation(a === undefined ? undefined : text(a), b as string | undefined ?? defaults().modelId, c as string | undefined ?? defaults().channelId)
      case C.GET_MESSAGES: return store.getConversationMessages(id(a))
      case C.GET_RECENT_MESSAGES: if (!Number.isInteger(b) || Number(b) < 1 || Number(b) > 10000) throw new Error('Chat分页参数无效'); return store.getRecentMessages(id(a), Number(b))
      case C.GET_BRANCH: return store.getConversationBranch(id(a))
      case C.GET_BRANCH_TREE: return store.getBranchTree(id(a))
      case C.GET_MESSAGE_CONTENT: return store.getMessageContent(id(a), text(b))
      case C.UPDATE_TITLE: return store.updateConversationMeta(id(a), { title: text(b), titleLockedAt: Date.now() })
      case C.UPDATE_MODEL: { const key = id(a); const meta = store.getConversationMeta(key)!; if (b !== undefined) text(b); if (c !== undefined) text(c); if (b !== undefined || c !== undefined) model(c ?? meta.channelId, b ?? meta.modelId); return store.updateConversationMeta(key, { modelId: b as string | undefined, channelId: c as string | undefined }) }
      case C.TOGGLE_PIN: { const key = id(a); const meta = store.getConversationMeta(key)!; return store.updateConversationMeta(key, { pinned: !meta.pinned, ...(!meta.pinned ? { archived: false } : {}) }, { touchUpdatedAt: false }) }
      case C.TOGGLE_ARCHIVE: { const key = id(a); const meta = store.getConversationMeta(key)!; return store.updateConversationMeta(key, { archived: !meta.archived, ...(!meta.archived ? { pinned: false } : {}) }, { touchUpdatedAt: false }) }
      case C.SEARCH_MESSAGES: return store.searchConversationMessages(text(a))
      case C.SET_ACTIVE_PATH: if (active.has(id(a))) throw new Error('Chat正在生成'); if (!Array.isArray(b) || b.some(value => typeof value !== 'string')) throw new Error('Chat分支路径无效'); store.setActivePath(id(a), b); return store.getConversationBranch(id(a))
      case C.UPDATE_CONTEXT_DIVIDERS: if (!Array.isArray(b) || b.some(value => typeof value !== 'string')) throw new Error('Chat分隔线无效'); return store.updateContextDividers(id(a), b)
      case C.FORK_BRANCH_AT: { const key = id(a); if (active.has(key)) throw new Error('Chat正在生成'); if (!c || typeof c !== 'object' || !('content' in c) || !('role' in c) || c.role !== 'user') throw new Error('Chat分支消息无效'); const payload = c as { role: 'user'; content: string; attachments?: ChatSendInput['attachments']; knowledgeReferences?: unknown[] }; text(payload.content); if (payload.knowledgeReferences?.length) unsupported(); files(payload.attachments, key); return store.forkBranchAt(key, text(b), payload as Parameters<typeof store.forkBranchAt>[2]) }
      case C.DELETE_MESSAGE: if (active.has(id(a))) throw new Error('Chat正在生成'); return store.deleteMessage(id(a), text(b))
      case C.TRUNCATE_MESSAGES_FROM: if (c !== undefined && typeof c !== 'boolean') throw new Error('Chat截断参数无效'); if (active.has(id(a))) throw new Error('Chat正在生成'); return store.truncateMessagesFrom(id(a), text(b), c === true)
      case C.DELETE_CONVERSATION: if (active.has(id(a))) throw new Error('Chat正在生成'); return store.deleteConversation(id(a))
      case C.SAVE_ATTACHMENT: if (!a || typeof a !== 'object') throw new Error('Chat附件参数无效'); return attachments.save(a as AttachmentSaveInput)
      case C.READ_ATTACHMENT: return attachments.readBase64(text(a))
      case C.DELETE_ATTACHMENT: return attachments.remove(text(a))
      case C.EXTRACT_ATTACHMENT_TEXT: return attachments.extractText(text(a))
      case C.STOP_GENERATION: engine.stopGeneration(id(a)); return { stopped: true }
      case C.SEND_MESSAGE: {
        if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Chat发送参数无效')
        const allowed = new Set(['conversationId', 'runId', 'userMessage', 'messageHistory', 'channelId', 'modelId', 'systemMessage', 'contextLength', 'contextDividers', 'attachments', 'knowledgeReferences', 'thinkingEnabled', 'enabledToolIds', 'pendingUserMessageId'])
        if (Object.keys(a).some(key => !allowed.has(key))) throw new Error('Core Chat发送包含未支持的选项')
        const input = a as ChatSendInput
        const key = id(input.conversationId)
        text(input.userMessage); if (!input.runId || typeof input.runId !== 'string' || input.runId.length > 200) throw new Error('Chat runId无效')
        model(input.channelId, input.modelId)
        if (active.has(key)) throw new Error('Chat正在生成')
        if (input.enabledToolIds !== undefined && (!Array.isArray(input.enabledToolIds) || input.enabledToolIds.some(value => typeof value !== 'string'))) throw new Error('Chat工具参数无效')
        if (input.knowledgeReferences !== undefined && !Array.isArray(input.knowledgeReferences)) throw new Error('Chat资料参数无效')
        if (!input.userMessage.trim() && !input.attachments?.length && !input.pendingUserMessageId) throw new Error('Chat消息不能为空')
        if (input.enabledToolIds?.length || input.knowledgeReferences?.length) unsupported()
        if (input.thinkingEnabled !== undefined && typeof input.thinkingEnabled !== 'boolean') throw new Error('Chat思考参数无效')
        if (input.systemMessage !== undefined) text(input.systemMessage)
        if (input.contextLength !== undefined && input.contextLength !== 'infinite' && (!Number.isInteger(input.contextLength) || input.contextLength < 0)) throw new Error('Chat上下文参数无效')
        if (input.contextDividers !== undefined && (!Array.isArray(input.contextDividers) || input.contextDividers.some(item => typeof item !== 'string'))) throw new Error('Chat上下文分隔线无效')
        files(input.attachments, key)
        const history = store.getConversationBranch(key)
        for (const message of history) { files(message.attachments, key); if (message.knowledgeReferences?.length) unsupported() }
        if (input.pendingUserMessageId !== undefined && (typeof input.pendingUserMessageId !== 'string' || !input.pendingUserMessageId)) throw new Error('Chat待发送消息ID无效')
        if (input.pendingUserMessageId && !history.some(message => message.id === input.pendingUserMessageId && message.role === 'user' && message.content === input.userMessage)) throw new Error('Chat待发送分支消息不存在或不一致')
        const promise = engine.sendMessage({ ...input, messageHistory: history }).catch(error => options.emit(key, C.STREAM_ERROR, { conversationId: key, runId: input.runId, error: String(error) })).finally(() => { if (active.get(key)?.runId === input.runId) active.delete(key) })
        active.set(key, { runId: input.runId, promise })
        return { accepted: true, runId: input.runId }
      }
      case C.GENERATE_TITLE: { const input = a as Parameters<typeof engine.generateTitle>[0]; if (!input || typeof input !== 'object') throw new Error('Chat标题参数无效'); model(input.channelId, input.modelId); text(input.userMessage); return engine.generateTitle(input) }
      case C.AUTO_TITLE: { const input = a as Parameters<typeof engine.autoTitleConversation>[0]; id(input?.conversationId); model(input.channelId, input.modelId); return engine.autoTitleConversation(input) }
      case C.REGENERATE_TITLE: { const key = id(a); const meta = store.getConversationMeta(key)!; if (b !== undefined) text(b); if (c !== undefined) text(c); model(b || meta.channelId, c || meta.modelId); return engine.regenerateConversationTitle(key, b as string | undefined, c as string | undefined) }
      default: return unsupported()
    }
  }
  return { operation, snapshot: () => { assertIndexVersion(); return ({ conversations: store.listConversations(true), activeRuns: [...active].map(([conversationId, run]) => ({ conversationId, runId: run.runId })) }) }, shutdown: async () => { closed = true; engine.stopAllGenerations(); await Promise.all([...active.values()].map(run => run.promise)) } }
}
export type CoreChat = ReturnType<typeof createCoreChat>
