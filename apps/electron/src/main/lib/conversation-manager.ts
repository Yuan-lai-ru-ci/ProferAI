/**
 * 对话管理器
 *
 * 负责对话的 CRUD 操作和消息持久化。
 * - 对话索引：~/.proma/conversations.json（轻量元数据，含 activePath 字段）
 * - 消息存储：~/.proma/conversations/{id}.jsonl（JSONL，逐行追加，每条带 parentId）
 * - 旧式 sidecar（已废弃，仅历史数据兼容读取）：~/.proma/conversations/{id}.discarded.jsonl
 *
 * 消息结构：所有消息通过 parentId 形成一棵/多棵 DAG；每一时刻对话有一个 active 路径
 * (activePath: string[]) 表示主视图当前展示的「root→leaf 全段」消息链：
 * - 必须以某条 parentId=null 的根消息开始
 * - 整链必须连续（每条消息的 parentId 都严格指向链中前一条）
 * - 必须从根延伸到当前选中叶节点，不能跳过中间节点
 * - 入库前由 setActivePath 校验，非 root→leaf 一律抛错；删除类操作后由
 *   deleteAndFixActivePath 等函数归一化兜底，所有写入路径统一契约。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import {
  getConversationsIndexPath,
  getConversationsDir,
  getConversationMessagesPath,
  getConversationDiscardedPath,
} from './config-paths'
import { deleteConversationAttachments, deleteAttachment } from './attachment-service'
import type {
  ConversationMeta,
  ChatMessage,
  RecentMessagesResult,
  MessageSearchResult,
  DiscardedSegmentRecord,
  BranchTreeSnapshot,
  BranchTreeNode,
} from '@profer/shared'

/**
 * 对话索引文件格式
 */
interface ConversationsIndex {
  /** 配置版本号 */
  version: number
  /** 对话元数据列表 */
  conversations: ConversationMeta[]
}

/** 当前索引版本 */
const INDEX_VERSION = 1

/**
 * （re-export 形式的本地别名，便于内部阅读）
 *
 * 一条"被丢弃消息段"的持久化记录
 *
 * 每次 resend / edit-resend 之前由 ChatView 主动调用 captureDiscardedSegment 写入。
 * - segment[0] 一定是触发截断的那条 user message 自身；
 * - 后续元素是当时该 user message 之后到文件末尾为止的全部消息
 *   （通常依次为：助手回复、可能的工具调用、可能的后续轮次）。
 */

// ===== 消息历史（仅旧 sidecar 兼容读取）=====
// 旧保留
export type { DiscardedSegmentRecord } from '@profer/shared'

/**
 * 读取对话索引文件
 */
function readIndex(): ConversationsIndex {
  const indexPath = getConversationsIndexPath()
  const data = readJsonFileSafe<ConversationsIndex>(indexPath)
  if (data) return data
  return { version: INDEX_VERSION, conversations: [] }
}

/**
 * 写入对话索引文件
 */
function writeIndex(index: ConversationsIndex): void {
  const indexPath = getConversationsIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[对话管理] 写入索引文件失败:', error)
    throw new Error('写入对话索引失败')
  }
}

/**
 * Chat 对话的默认标题。
 *
 * 自动命名窗口用它与实际标题对比，判断「这个标题是用户起的还是还没起」。
 */
export const DEFAULT_CONVERSATION_TITLE = '新对话'

/**
 * 获取单个对话元数据（不存在时返回 undefined）
 */
export function getConversationMeta(id: string): ConversationMeta | undefined {
  return readIndex().conversations.find((c) => c.id === id)
}

/**
 * 获取对话列表（按 updatedAt 降序）
 *
 * @param includeArchived 是否包含已归档对话；默认 false（高频侧边栏刷新只拉活跃）
 */
export function listConversations(includeArchived = false): ConversationMeta[] {
  const index = readIndex()
  return index.conversations
    .filter((c) => includeArchived || !c.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 已归档对话数量（轻量计数，不排序、不返回 meta）
 */
export function countArchivedConversations(): number {
  const index = readIndex()
  let count = 0
  for (const c of index.conversations) {
    if (c.archived) count += 1
  }
  return count
}

/**
 * 创建新对话
 *
 * @param title 对话标题（默认"新对话"）
 * @param modelId 默认模型 ID
 * @param channelId 使用的渠道 ID
 * @returns 创建的对话元数据
 */
export function createConversation(
  title?: string,
  modelId?: string,
  channelId?: string,
): ConversationMeta {
  const index = readIndex()
  const now = Date.now()

  const meta: ConversationMeta = {
    id: randomUUID(),
    title: title || DEFAULT_CONVERSATION_TITLE,
    modelId,
    channelId,
    createdAt: now,
    updatedAt: now,
  }

  index.conversations.push(meta)
  writeIndex(index)

  // 确保消息目录存在
  getConversationsDir()

  console.log(`[对话管理] 已创建对话: ${meta.title} (${meta.id})`)
  return meta
}

/**
 * 读取对话的所有消息
 *
 * 逐行读取 JSONL 文件，解析每行为 ChatMessage。带 lazy 迁移：
 * 若发现任意一条缺 parentId 字段，会同步重写整文件并把 activePath 初始化为整条链。
 *
 * @param id 对话 ID
 * @returns 消息列表（已保证 parentId 字段）
 */
export function getConversationMessages(id: string): ChatMessage[] {
  ensureTreeMigrated(id)

  const filePath = getConversationMessagesPath(id)
  if (!existsSync(filePath)) return []

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return lines.map((line) => JSON.parse(line) as ChatMessage)
  } catch (error) {
    console.error(`[对话管理] 读取消息失败 (${id}):`, error)
    return []
  }
}

/**
 * 按消息 ID 取单条消息的完整 content（不返回附件等大字段）
 *
 * 给 BranchTreeView 的 hover popover 用：避免传输全量 ChatMessage。
 * 找不到时返回 null。
 */
export function getMessageContent(conversationId: string, messageId: string): string | null {
  const messages = getConversationMessages(conversationId)
  const target = messages.find((m) => m.id === messageId)
  if (!target) return null
  return target.content ?? ''
}

/**
 * 读取对话的最近 N 条消息（从尾部读取）
 *
 * 用于分页加载：首次打开对话时只加载尾部少量消息，
 * 用户向上滚动时再加载全部历史。
 *
 * @param id 对话 ID
 * @param limit 返回的最大消息数
 * @returns 最近的消息列表 + 总数 + 是否还有更多
 */
export function getRecentMessages(id: string, limit: number): RecentMessagesResult {
  const filePath = getConversationMessagesPath(id)

  if (!existsSync(filePath)) {
    return { messages: [], total: 0, hasMore: false }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    const total = lines.length

    // 如果总数不超过 limit，直接返回全部
    if (total <= limit) {
      const messages = lines.map((line) => JSON.parse(line) as ChatMessage)
      return { messages, total, hasMore: false }
    }

    // 只解析尾部 limit 行
    const recentLines = lines.slice(-limit)
    const messages = recentLines.map((line) => JSON.parse(line) as ChatMessage)
    return { messages, total, hasMore: true }
  } catch (error) {
    console.error(`[对话管理] 读取最近消息失败 (${id}):`, error)
    return { messages: [], total: 0, hasMore: false }
  }
}

/**
 * 追加一条消息到对话的 JSONL 文件
 *
 * 使用 appendFile，无需读取整个文件。
 *
 * @param id 对话 ID
 * @param message 消息对象
 */
export function appendMessage(id: string, message: ChatMessage): void {
  const filePath = getConversationMessagesPath(id)

  try {
    const line = JSON.stringify(message) + '\n'
    appendFileSync(filePath, line, 'utf-8')

    // 追加消息时更新 updatedAt，若已归档则自动恢复活跃
    const index = readIndex()
    const idx = index.conversations.findIndex((c) => c.id === id)
    if (idx !== -1) {
      const conv = index.conversations[idx]!
      conv.updatedAt = Date.now()
      if (conv.archived) conv.archived = false
      writeIndex(index)
    }
  } catch (error) {
    console.error(`[对话管理] 追加消息失败 (${id}):`, error)
    throw new Error('追加消息失败')
  }
}

/**
 * 全量覆写对话消息
 *
 * 用于编辑、删除消息等需要修改历史的场景。
 *
 * @param id 对话 ID
 * @param messages 完整消息列表
 */
export function saveConversationMessages(id: string, messages: ChatMessage[]): void {
  const filePath = getConversationMessagesPath(id)

  try {
    const content = messages.map((msg) => JSON.stringify(msg)).join('\n') + (messages.length > 0 ? '\n' : '')
    writeFileSync(filePath, content, 'utf-8')
  } catch (error) {
    console.error(`[对话管理] 保存消息失败 (${id}):`, error)
    throw new Error('保存消息失败')
  }
}

/**
 * 更新对话元数据
 *
 * @param id 对话 ID
 * @param updates 需要更新的字段
 * @param options.touchUpdatedAt 是否把本次写入算作「对话活跃」并刷新 `updatedAt`（默认 true）。
 *   置顶这类纯展示状态切换传 false：它不产生新内容，不该改写「最后更新」时间。
 * @returns 更新后的对话元数据
 */
export function updateConversationMeta(
  id: string,
  updates: Partial<Pick<ConversationMeta, 'title' | 'titleAutoGeneratedAt' | 'titleRefineAttempts' | 'titleLockedAt' | 'modelId' | 'channelId' | 'contextDividers' | 'contextLength' | 'pinned' | 'archived' | 'activePath'>>,
  options: { touchUpdatedAt?: boolean } = {},
): ConversationMeta {
  const index = readIndex()
  const idx = index.conversations.findIndex((c) => c.id === id)

  if (idx === -1) {
    throw new Error(`对话不存在: ${id}`)
  }

  const existing = index.conversations[idx]!
  // 非手动归档操作时，若对话已归档则自动恢复为活跃
  const autoUnarchive = existing.archived && !('archived' in updates)
  const updated: ConversationMeta = {
    ...existing,
    ...updates,
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: options.touchUpdatedAt === false ? existing.updatedAt : Date.now(),
  }

  index.conversations[idx] = updated
  writeIndex(index)

  console.log(`[对话管理] 已更新对话: ${updated.title} (${updated.id})`)
  return updated
}

/**
 * 删除对话
 *
 * 同时删除索引条目和消息文件。
 *
 * @param id 对话 ID
 */
export function deleteConversation(id: string): void {
  const index = readIndex()
  const idx = index.conversations.findIndex((c) => c.id === id)

  if (idx === -1) {
    console.warn(`[对话管理] 对话不存在，跳过删除: ${id}`)
    return
  }

  const removed = index.conversations.splice(idx, 1)[0]!
  writeIndex(index)

  // 删除消息文件
  const filePath = getConversationMessagesPath(id)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[对话管理] 删除消息文件失败 (${id}):`, error)
    }
  }

  // 删除对话的历史丢弃段文件
  deleteDiscardedSegments(id)

  console.log(`[对话管理] 已删除对话: ${removed.title} (${removed.id})`)

  // 删除对话附件目录
  deleteConversationAttachments(id)
}

/**
 * 删除指定消息
 *
 * 读取 JSONL → 过滤掉目标消息 → 覆写文件 → 返回更新后消息列表。
 *
 * @param conversationId 对话 ID
 * @param messageId 要删除的消息 ID
 * @returns 更新后的消息列表
 */
export function deleteMessage(conversationId: string, messageId: string): ChatMessage[] {
  return deleteMessageFromTree(conversationId, messageId)
}

/**
 * 从指定消息开始截断对话（包含该消息）
 *
 * 常用于“重新发送”场景：删除目标消息及其后的所有消息，
 * 让对话从该点重新分叉。
 *
 * @param conversationId 对话 ID
 * @param messageId 截断起点消息 ID（包含）
 * @param preserveFirstMessageAttachments 是否保留起点消息的附件文件
 * @returns 截断后的消息列表（起点之前的消息）
 */
export function truncateMessagesFrom(
  conversationId: string,
  messageId: string,
  preserveFirstMessageAttachments = false,
): ChatMessage[] {
  const messages = getConversationMessages(conversationId)
  const startIndex = messages.findIndex((msg) => msg.id === messageId)

  if (startIndex === -1) {
    console.warn(`[对话管理] 截断起点消息不存在: ${messageId}`)
    return messages
  }

  const kept = messages.slice(0, startIndex)
  const removed = messages.slice(startIndex)

  // 删除被截断消息关联的附件文件
  removed.forEach((msg, idx) => {
    if (!msg.attachments || msg.attachments.length === 0) return
    // 允许保留起点消息的附件（用于“重发”复用）
    if (idx === 0 && preserveFirstMessageAttachments) return

    msg.attachments.forEach((attachment) => {
      deleteAttachment(attachment.localPath)
    })
  })

  saveConversationMessages(conversationId, kept)
  console.log(`[对话管理] 已从消息截断: ${messageId} (对话 ${conversationId})`)
  return kept
}

/**
 * 更新对话的上下文分隔线
 *
 * @param conversationId 对话 ID
 * @param dividers 新的分隔线消息 ID 列表
 * @returns 更新后的对话元数据
 */
export function updateContextDividers(conversationId: string, dividers: string[]): ConversationMeta {
  return updateConversationMeta(conversationId, { contextDividers: dividers })
}

/**
 * 自动归档超过指定天数未更新的对话
 *
 * 置顶对话不会被归档。
 *
 * @param daysThreshold 天数阈值
 * @returns 本次归档的对话数量
 */
export function autoArchiveConversations(daysThreshold: number): number {
  const index = readIndex()
  const threshold = Date.now() - daysThreshold * 86_400_000
  let count = 0

  for (const conv of index.conversations) {
    if (!conv.pinned && !conv.archived && conv.updatedAt < threshold) {
      conv.archived = true
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[对话管理] 自动归档 ${count} 个对话（阈值: ${daysThreshold} 天）`)
  }

  return count
}

/**
 * 搜索对话消息内容
 *
 * 按行流式读取每个对话的 JSONL 文件，命中即早退，避免一次性加载大文件到内存。
 * 每个对话最多返回 1 条匹配（内容版）+ 多个历史版本匹配 + 多个已丢弃段匹配，
 * 总计达到 maxResults 即停止扫描后续会话。
 *
 * 匹配范围：
 * 1. 主消息流的 current content
 * 2. 主消息流的 history[i].content（未来 inline-edit 启用后生效）
 * 3. sidecar `discarded.jsonl` 里每条历史段每条消息的 content
 *
 * @param query 搜索关键词
 * @returns 匹配结果列表
 */
export async function searchConversationMessages(query: string): Promise<MessageSearchResult[]> {
  if (!query || query.length < 2) return []

  const index = readIndex()
  const results: MessageSearchResult[] = []
  const queryLower = query.toLowerCase()
  const maxResults = 30

  for (const conv of index.conversations) {
    if (results.length >= maxResults) break

    // 1) 主消息流
    const mainPath = getConversationMessagesPath(conv.id)
    if (existsSync(mainPath)) {
      const mainHits = await findMatchesInJsonl(mainPath, queryLower, query.length, 'main')
      for (const hit of mainHits) {
        if (results.length >= maxResults) break
        results.push({
          conversationId: conv.id,
          conversationTitle: conv.title,
          messageId: hit.messageId,
          role: hit.role,
          snippet: hit.snippet,
          matchStart: hit.matchStart,
          matchLength: query.length,
          archived: conv.archived,
          version: hit.version,
        })
      }
      if (results.length >= maxResults) break
    }

    // 2) sidecar 历史段
    const discardedPath = getConversationDiscardedPath(conv.id)
    if (existsSync(discardedPath)) {
      const discardedHits = await findMatchesInDiscardedSegments(discardedPath, queryLower, query.length)
      for (const hit of discardedHits) {
        if (results.length >= maxResults) break
        results.push({
          conversationId: conv.id,
          conversationTitle: conv.title,
          messageId: hit.messageId,
          role: hit.role,
          snippet: hit.snippet,
          matchStart: hit.matchStart,
          matchLength: query.length,
          archived: conv.archived,
          version: hit.version,
          segmentEntryId: hit.segmentEntryId,
        })
      }
      if (results.length >= maxResults) break
    }
  }

  return results
}

/**
 * 在主消息流 JSONL 中按行查找所有匹配项
 *
 * 返回：
 * - 每条消息 current content 首次匹配（保持向后兼容）
 * - 每条消息 history[i].content 首次匹配
 *
 * @returns 含 matchSource/version 标签的命中列表
 */
async function findMatchesInJsonl(
  filePath: string,
  queryLower: string,
  queryLength: number,
  _fileLabel: 'main',
): Promise<Array<{
  messageId: string
  role: ChatMessage['role']
  snippet: string
  matchStart: number
  version: MessageSearchResult['version']
}>> {
  const out: Array<{
    messageId: string
    role: ChatMessage['role']
    snippet: string
    matchStart: number
    version: MessageSearchResult['version']
  }> = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let msg: ChatMessage
      try {
        msg = JSON.parse(line) as ChatMessage
      } catch {
        continue
      }

      // current content
      if (msg.content) {
        const hit = makeSnippet(msg.content, queryLower, queryLength)
        if (hit) {
          out.push({
            messageId: msg.id,
            role: msg.role,
            snippet: hit.snippet,
            matchStart: hit.matchStart,
            version: { source: 'current' },
          })
        }
      }

      // 注：旧的 per-message history 字段已废弃。新分支模型下不再有"消息内历史"。
      // 保留历史搜索的方式：扫描 sidecar discarded.jsonl（已由独立函数处理）。
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return out
}

/**
 * 在 sidecar discarded.jsonl 中查找所有命中
 *
 * 每条历史段的每条消息的 content 都会参与匹配；返回结果带上 segmentEntryId 以便 UI
 * 在抽屉里精确高亮/跳转到对应段。
 */
async function findMatchesInDiscardedSegments(
  filePath: string,
  queryLower: string,
  queryLength: number,
): Promise<Array<{
  messageId: string
  role: ChatMessage['role']
  snippet: string
  matchStart: number
  version: MessageSearchResult['version']
  segmentEntryId?: string
}>> {
  const out: Array<{
    messageId: string
    role: ChatMessage['role']
    snippet: string
    matchStart: number
    version: MessageSearchResult['version']
    segmentEntryId?: string
  }> = []

  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let record: DiscardedSegmentRecord
      try {
        record = JSON.parse(line) as DiscardedSegmentRecord
      } catch {
        continue
      }
      for (const msg of record.segment) {
        if (!msg.content) continue
        const hit = makeSnippet(msg.content, queryLower, queryLength)
        if (hit) {
          out.push({
            messageId: msg.id,
            role: msg.role,
            snippet: hit.snippet,
            matchStart: hit.matchStart,
            version: {
              source: 'discarded',
              editedAt: record.discardedAt,
              reason: record.reason,
            },
            segmentEntryId: record.entryId,
          })
        }
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return out
}

/**
 * 把匹配位置转换为带省略号的预览片段
 */
function makeSnippet(content: string, queryLower: string, queryLength: number): { snippet: string; matchStart: number } | null {
  const contentLower = content.toLowerCase()
  const matchIndex = contentLower.indexOf(queryLower)
  if (matchIndex === -1) return null

  const snippetStart = Math.max(0, matchIndex - 40)
  const snippetEnd = Math.min(content.length, matchIndex + queryLength + 40)
  const snippet = (snippetStart > 0 ? '...' : '') +
    content.slice(snippetStart, snippetEnd) +
    (snippetEnd < content.length ? '...' : '')
  const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)
  return { snippet, matchStart }
}

// ===== 分支树（DAG）=====

/**
 * 内部 in-memory 缓存：避免每次读都重新走 IO
 *
 * 设计为单调用栈解析：缓存命中直接返回，未命中则读 + 迁 + 写。
 * 任何会修改消息内容的函数（appendMessage、forkBranchAt 等）都必须 invalidate。
 */
const messagesCache = new Map<string, ChatMessage[]>()

function invalidateMessagesCache(conversationId: string): void {
  messagesCache.delete(conversationId)
}

/**
 * 确保对话的 JSONL 已迁移到 parentId-tree 模型
 *
 * - 对没有 parentId 的旧数据，按线性顺序推断 parentId = prev.id，首条 = null
 * - 同步初始化 ConversationMeta.activePath = 全部消息 ID 列表
 * - 写回文件（包含 parentId 字段的新版）
 *
 * 幂等：重复调用是 no-op。
 */
function ensureTreeMigrated(conversationId: string): void {
  const filePath = getConversationMessagesPath(conversationId)
  if (!existsSync(filePath)) return

  if (messagesCache.has(conversationId)) return

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  if (lines.length === 0) return

  const parsed: ChatMessage[] = []
  let needsRewrite = false

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as ChatMessage & { parentId?: string | null }
      if (!Object.prototype.hasOwnProperty.call(msg, 'parentId')) needsRewrite = true
      parsed.push(msg as ChatMessage)
    } catch (error) {
      console.warn('[对话管理] 消息行解析失败，跳过:', error)
    }
  }

  if (!needsRewrite) {
    messagesCache.set(conversationId, parsed)
    return
  }

  // 按线性顺序建链：第一条 parentId=null；之后 = 前一条 ID
  for (let i = 0; i < parsed.length; i++) {
    if (i === 0) {
      parsed[i] = { ...parsed[i]!, parentId: null }
    } else {
      parsed[i] = { ...parsed[i]!, parentId: parsed[i - 1]!.id }
    }
  }

  const content = parsed.map((msg) => JSON.stringify(msg)).join('\n') + '\n'
  writeFileSync(filePath, content, 'utf-8')
  messagesCache.set(conversationId, parsed)

  // 初始化 activePath：直接是线性链
  ensureActivePath(conversationId, parsed.map((m) => m.id))

  console.log(`[对话管理] 已将对话 ${conversationId} 迁移到 parentId-tree 模型（${parsed.length} 条）`)
}

/**
 * 读取（+保证已迁移的）对话全量消息，命中 in-memory 缓存
 */
function readAllMessagesFresh(conversationId: string): ChatMessage[] {
  ensureTreeMigrated(conversationId)
  const cached = messagesCache.get(conversationId)
  if (cached) return cached

  const filePath = getConversationMessagesPath(conversationId)
  if (!existsSync(filePath)) return []

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const out: ChatMessage[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ChatMessage)
    } catch {
      // skip
    }
  }
  messagesCache.set(conversationId, out)
  return out
}

/**
 * 把一组 chatMessage 写回主 JSONL，并更新 in-memory 缓存
 */
function writeAllMessages(conversationId: string, messages: ChatMessage[]): void {
  const filePath = getConversationMessagesPath(conversationId)
  const content = messages.map((msg) => JSON.stringify(msg)).join('\n') + (messages.length > 0 ? '\n' : '')
  writeFileSync(filePath, content, 'utf-8')
  messagesCache.set(conversationId, messages)
  touchConversationUpdatedAt(conversationId)
}

function touchConversationUpdatedAt(conversationId: string): void {
  const index = readIndex()
  const idx = index.conversations.findIndex((c) => c.id === conversationId)
  if (idx === -1) return
  const conv = index.conversations[idx]!
  conv.updatedAt = Date.now()
  if (conv.archived) conv.archived = false
  writeIndex(index)
}

/**
 * 获取对话激活分支（activePath）的全部消息，按链顺序
 *
 * 若 activePath 缺失或指向不存在的消息，回退为首条消息开始的整条最长链。
 */
export function getConversationBranch(conversationId: string): ChatMessage[] {
  const messages = readAllMessagesFresh(conversationId)
  if (messages.length === 0) return []

  const byId = new Map<string, ChatMessage>()
  for (const m of messages) byId.set(m.id, m)

  const meta = readIndex().conversations.find((c) => c.id === conversationId)
  const activePath = meta?.activePath && meta.activePath.length > 0 ? meta.activePath : null

  if (activePath) {
    const out: ChatMessage[] = []
    for (const id of activePath) {
      const msg = byId.get(id)
      if (!msg) break
      out.push(msg)
    }
    if (out.length > 0) return out
  }

  // 回退：找到 parentId === null 的根，按产生时间找最长链
  const roots = messages.filter((m) => m.parentId === null)
  const root = roots[0]
  if (!root) return []

  const out: ChatMessage[] = []
  let cursor: ChatMessage | undefined = root
  while (cursor) {
    out.push(cursor)
    const next = messages.find((m) => m.parentId === cursor!.id)
    cursor = next
  }
  return out
}

/**
 * 设置当前对话的 activePath
 *
 * 严格约束（PR #121 review by Yuan-lai-ru-ci）：
 * - 路径必须构成自某条 parentId=null 根开始的合法链
 * - 不允许跳过父节点、不允许节点不存在、不允许从中间节点开始
 * - 失败时抛错
 *
 * 之前的实现允许从中间节点开始（分支展示场景），但 shared/types/chat.ts 的
 * activePath 注释又要求 root→leaf，两边矛盾；本版统一为「严格 root→leaf」语义。
 */
export function setActivePath(conversationId: string, path: string[]): void {
  const messages = readAllMessagesFresh(conversationId)
  if (path.length === 0) throw new Error('activePath 不能为空')

  const byId = new Map<string, ChatMessage>()
  for (const m of messages) byId.set(m.id, m)

  let prev: ChatMessage | undefined
  for (let i = 0; i < path.length; i++) {
    const id = path[i]!
    const msg = byId.get(id)
    if (!msg) throw new Error(`activePath 包含不存在的消息 id=${id}`)
    if (i === 0) {
      if (msg.parentId !== null) {
        throw new Error(`activePath 必须从 parentId=null 的根消息开始，但 ${id} 的 parentId=${msg.parentId}`)
      }
    } else {
      if (msg.parentId !== prev!.id) throw new Error(`activePath 链不连续：${prev!.id} → ${id}`)
    }
    prev = msg
  }

  const updated = updateConversationMeta(conversationId, { activePath: path })
  console.log(`[对话管理] 已设置 activePath (${conversationId}, ${path.length} 节点)`)
  return updated as unknown as void
}

/** 兼容写法：返回新的 meta */
export function ensureActivePath(conversationId: string, fallbackPath: string[]): void {
  const index = readIndex()
  const idx = index.conversations.findIndex((c) => c.id === conversationId)
  if (idx === -1) return
  const conv = index.conversations[idx]!
  if (!conv.activePath || conv.activePath.length === 0) {
    conv.activePath = fallbackPath
    writeIndex(index)
  }
}

/**
 * 在指定 parentId 下分叉一个新的 user message，并把它纳入 active 路径
 *
 * 语义：把 anchorId 的母亲当作新 message 的母亲 → 新旧 user message 在同一层（兄弟）。
 * 调用场景：用户"重发 / 编辑后重发"：anchorId 一般是被点的 user message 自身。
 *
 * 该函数做三件事：
 * 1. 创建新 user message（parentId = anchorId.parentId，或显式 override）
 * 2. 把它写入主 JSONL
 * 3. 把当前 activePath 截断到 anchorId 之前（不含 anchor 及之后的整段），再 append 新 ID
 *
 * @returns 新消息对象（已写入 JSONL）
 */
export function forkBranchAt(
  conversationId: string,
  anchorId: string,
  payload: {
    role: 'user'
    content: string
    attachments?: ChatMessage['attachments']
    knowledgeReferences?: ChatMessage['knowledgeReferences']
  },
): ChatMessage {
  const messages = readAllMessagesFresh(conversationId)
  const anchor = messages.find((m) => m.id === anchorId)
  if (!anchor) throw new Error(`找不到 anchor 消息: ${anchorId}`)

  const newMsg: ChatMessage = {
    id: randomUUID(),
    parentId: anchor.parentId,
    role: payload.role,
    content: payload.content,
    createdAt: Date.now(),
    attachments: payload.attachments,
    knowledgeReferences: payload.knowledgeReferences,
  }

  // 写回主 JSONL
  const updated = [...messages, newMsg]
  writeAllMessages(conversationId, updated)

  // 重算 activePath：截断到 anchor 之前 + append newMsg
  const meta = readIndex().conversations.find((c) => c.id === conversationId)
  const currentPath: string[] = meta?.activePath && meta.activePath.length > 0 ? meta.activePath : []
  const truncIdx = currentPath.indexOf(anchorId)
  const nextPath = truncIdx >= 0 ? [...currentPath.slice(0, truncIdx), newMsg.id] : [...currentPath, newMsg.id]
  setActivePath(conversationId, nextPath)

  console.log(`[对话管理] forkBranchAt ${anchorId} → 新节点 ${newMsg.id} (parent=${anchor.parentId})`)
  return newMsg
}

/**
 * 在 active 路径末尾追加一个节点（一般用于流式完成后挂上 assistant 回复）
 *
 * 不同于 forkBranchAt：appendBranchTail 是把节点挂在当前 active 末端的节点下，
 * 并把节点追加到 activePath 末尾。
 *
 * @returns 新消息对象
 */
export function appendBranchTail(
  conversationId: string,
  message: Omit<ChatMessage, 'id' | 'parentId' | 'createdAt'> & { id?: string; parentId?: string | null; createdAt?: number },
): ChatMessage {
  const messages = readAllMessagesFresh(conversationId)
  const meta = readIndex().conversations.find((c) => c.id === conversationId)
  const activePath = meta?.activePath && meta.activePath.length > 0 ? meta.activePath : []
  const parentId = message.parentId ?? (activePath.length > 0 ? activePath[activePath.length - 1]! : null)

  const newMsg: ChatMessage = {
    id: message.id ?? randomUUID(),
    parentId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt ?? Date.now(),
    model: message.model,
    reasoning: message.reasoning,
    stopped: message.stopped,
    error: message.error,
    attachments: message.attachments,
    toolActivities: message.toolActivities,
    knowledgeReferences: message.knowledgeReferences,
  }

  writeAllMessages(conversationId, [...messages, newMsg])
  setActivePath(conversationId, [...activePath, newMsg.id])
  return newMsg
}

/**
 * 生成 DAG 的快照，UI 拿去渲染树
 */
export function getBranchTree(conversationId: string): BranchTreeSnapshot {
  const messages = readAllMessagesFresh(conversationId)
  const meta = readIndex().conversations.find((c) => c.id === conversationId)
  const activePath = meta?.activePath && meta.activePath.length > 0 ? meta.activePath : []

  const nodes: Record<string, BranchTreeNode> = {}
  const byId = new Map<string, ChatMessage>()
  for (const m of messages) byId.set(m.id, m)

  // 先建空 node
  for (const m of messages) {
    nodes[m.id] = {
      id: m.id,
      parentId: m.parentId,
      role: m.role,
      createdAt: m.createdAt,
      preview: (m.content || '').slice(0, 100),
      childIds: [],
    }
  }
  // 再填 childIds
  for (const m of messages) {
    if (m.parentId && nodes[m.parentId]) {
      nodes[m.parentId]!.childIds.push(m.id)
    }
  }
  // 排序 childIds：按 createdAt 升序
  for (const id of Object.keys(nodes)) {
    nodes[id]!.childIds.sort((a, b) => nodes[a]!.createdAt - nodes[b]!.createdAt)
  }

  const rootIds = messages.filter((m) => m.parentId === null).map((m) => m.id)

  return { nodes, rootIds, activePath }
}

/**
 * 检查传入的 id 是否在 activePath 上
 */
export function isOnActiveBranch(conversationId: string, messageId: string): boolean {
  const meta = readIndex().conversations.find((c) => c.id === conversationId)
  return !!meta?.activePath?.includes(messageId)
}

/**
 * 删除某条消息（如等于单条删除需求）
 *
 * 注意：删除非叶节点会留下"悬空父指针"，需要 UI 主动选择重连（暂不实现）。
 * 现阶段仅允许删除叶节点。
 */
/**
 * 删除指定消息及其整条 descendant 子树（DAG 模型下）
 *
 * 语义：
 * - 删除 target = 同时删除它下面挂的所有回复（assistant / tool / 后续 user 链）
 * - 只沿 target 向下递归收集 descendant，不会动到 target.parentId 的其它兄弟分支
 * - activePath 中所有已被删除的 id 都会被过滤掉，并按链连续性二次截断
 *   - 若 target 在 activePath 上，截断到 target 之前（保证链合法）
 *   - 若 activePath 被清空，退回到 remaining 中第一条 parentId=null 的根
 *     （为了与 setActivePath 的「严格 root→leaf」契约一致，不能再用 target.parent 这种中间节点兜底）
 *
 * @returns 更新后的 active path 上的消息（= getConversationBranch 结果），用于前端 setMessages
 */
export function deleteMessageFromTree(conversationId: string, messageId: string): ChatMessage[] {
  const messages = readAllMessagesFresh(conversationId)
  const byId = new Map<string, ChatMessage>()
  for (const m of messages) byId.set(m.id, m)

  const target = byId.get(messageId)
  if (!target) {
    console.warn('[对话管理] 消息不存在:', messageId)
    return messages
  }

  // 1) 收集 target + 它的整条 descendant 子树（不动兄弟分支）
  const toDelete = new Set<string>([messageId])
  let grew = true
  while (grew) {
    grew = false
    for (const m of messages) {
      if (m.parentId && toDelete.has(m.parentId) && !toDelete.has(m.id)) {
        toDelete.add(m.id)
        grew = true
      }
    }
  }

  // 2) 删附件（被删的每个节点都尝试清一下）
  for (const id of toDelete) {
    const m = byId.get(id)
    if (m?.attachments && m.attachments.length > 0) {
      for (const att of m.attachments) {
        try {
          deleteAttachment(att.localPath)
        } catch (err) {
          console.warn(`[对话管理] 删除附件失败 (${att.localPath}):`, err)
        }
      }
    }
  }

  // 3) 写回 messages
  const remaining = messages.filter((m) => !toDelete.has(m.id))
  writeAllMessages(conversationId, remaining)

  // 4) 修复 activePath：过滤被删 id + 按链连续性二次截断
  const meta = readIndex().conversations.find((c) => c.id === conversationId)
  if (meta?.activePath && meta.activePath.length > 0) {
    const filtered = meta.activePath.filter((id) => !toDelete.has(id))
    const byIdNew = new Map<string, ChatMessage>()
    for (const m of remaining) byIdNew.set(m.id, m)

    const truncated: string[] = []
    let prev: string | null = null
    for (const id of filtered) {
      const m = byIdNew.get(id)
      if (!m) break
      if (prev === null) {
        // 第一个节点作为锚点。前提：输入 activePath 已满足「root→leaf」契约
        // （由 setActivePath 入口校验保证），这里不再二次断言；后续按 parent 链连续性追加。
        truncated.push(id)
        prev = id
      } else if (m.parentId === prev) {
        truncated.push(id)
        prev = id
      } else {
        // 链断了，截断到此处之前
        break
      }
    }

    if (truncated.length === 0) {
      // 整条 activePath 都没了：统一退到 remaining 中第一条 parentId=null 的根。
      // 为遵守 setActivePath 的「严格 root→leaf」契约，不能再退到 target.parent
      // （target.parent 是中间节点、违反约定）；不再合法时唯一兜底就是根。
      const root = remaining.find((m) => m.parentId === null)
      if (root) updateConversationMeta(conversationId, { activePath: [root.id] })
    } else if (truncated.length !== meta.activePath.length) {
      updateConversationMeta(conversationId, { activePath: truncated })
    }
  }

  console.log(`[对话管理] 已删除子树 (${messageId}, 共 ${toDelete.size} 节点)`)
  // 返回当前 active path 上的消息（让前端直接渲染，不必自己再过滤）
  return getConversationBranch(conversationId)
}

/**
 * 读取对话的所有"被丢弃消息段"，按时间倒序（最新在前）
 *
 * 仅用于兼容旧数据。新分支模型下不再有 sidecar 写入。
 */
export function listDiscardedSegments(conversationId: string): DiscardedSegmentRecord[] {
  const filePath = getConversationDiscardedPath(conversationId)

  if (!existsSync(filePath)) return []

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error(`[对话管理] 读取丢弃段失败 (${conversationId}):`, error)
    return []
  }

  const lines = raw.split('\n').filter((line) => line.trim())
  const records: DiscardedSegmentRecord[] = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as DiscardedSegmentRecord)
    } catch (error) {
      console.warn('[对话管理] 丢弃段 JSON 解析失败，已跳过:', error)
    }
  }

  return records.sort((a, b) => b.discardedAt - a.discardedAt)
}

/**
 * 删除对话的丢弃段文件
 *
 * 在 deleteConversation 时一并清理，避免遗留历史。
 */
export function deleteDiscardedSegments(conversationId: string): void {
  const filePath = getConversationDiscardedPath(conversationId)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
      console.log(`[对话管理] 已删除对话的丢弃段文件: ${conversationId}`)
    } catch (error) {
      console.warn(`[对话管理] 删除丢弃段文件失败 (${conversationId}):`, error)
    }
  }
}
