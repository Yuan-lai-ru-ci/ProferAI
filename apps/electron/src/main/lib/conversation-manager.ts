/** Chat 持久化的桌面宿主装配；业务实现统一由 session-store 提供。 */
import { createConversationStore } from '@profer/session-store'
import { getConversationsIndexPath, getConversationsDir, getConversationMessagesPath, getConversationDiscardedPath } from './config-paths'
import { deleteConversationAttachments, deleteAttachment } from './attachment-service'
import { writeJsonFileAtomic } from './safe-file'
import { localCoreOwnsBusinessData } from './core-business-ownership'
export { DEFAULT_CONVERSATION_TITLE } from '@profer/session-store'
export type { DiscardedSegmentRecord } from '@profer/shared'
const store = createConversationStore({
  assertWritable: () => {
    if (localCoreOwnsBusinessData()) throw new Error('Core 已接管 Chat 业务数据，禁止桌面直接写入对话存储')
  },
  getConversationsIndexPath, getConversationsDir, getConversationMessagesPath, getConversationDiscardedPath, deleteConversationAttachments, deleteAttachment, writeJsonFileAtomic })
export const { getConversationMeta, listConversations, countArchivedConversations, createConversation, getConversationMessages, getMessageContent, getRecentMessages, appendMessage, saveConversationMessages, updateConversationMeta, deleteConversation, deleteMessage, truncateMessagesFrom, updateContextDividers, autoArchiveConversations, searchConversationMessages, getConversationBranch, setActivePath, ensureActivePath, forkBranchAt, appendBranchTail, getBranchTree, isOnActiveBranch, deleteMessageFromTree, listDiscardedSegments, deleteDiscardedSegments } = store
