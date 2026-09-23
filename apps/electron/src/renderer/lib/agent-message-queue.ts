import type { QuotedSelection } from '@/atoms/preview-atoms'

export type QueueDropPlacement = 'before' | 'after'

export interface AgentQueuedMessage {
  id: string
  text: string
  createdAt: number
  quotedSelection?: QuotedSelection
}

export function createAgentQueuedMessage(
  text: string,
  id: string,
  createdAt: number,
  quotedSelection?: QuotedSelection | null,
): AgentQueuedMessage {
  const message: AgentQueuedMessage = {
    id,
    text: text.trim(),
    createdAt,
  }
  if (quotedSelection) message.quotedSelection = quotedSelection
  return message
}

export function removeQueuedMessage(
  queue: AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== messageId)
}

/** in-flight 队列发送失败时，只有仍属于同一未停止 epoch 的消息才允许回队。 */
export function shouldRestoreQueuedMessageAfterFailure(
  sendEpoch: number,
  currentEpoch: number,
  stoppingOrStopped: boolean,
): boolean {
  return sendEpoch === currentEpoch && !stoppingOrStopped
}

export function restoreQueuedMessageToFront(
  queue: AgentQueuedMessage[],
  message: AgentQueuedMessage,
): AgentQueuedMessage[] {
  if (queue.some((item) => item.id === message.id)) return queue
  return [message, ...queue]
}

export function moveQueuedMessage(
  queue: AgentQueuedMessage[],
  sourceId: string,
  targetId: string,
  placement: QueueDropPlacement,
): AgentQueuedMessage[] {
  if (sourceId === targetId) return queue

  const source = queue.find((item) => item.id === sourceId)
  if (!source) return queue

  const withoutSource = queue.filter((item) => item.id !== sourceId)
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return queue

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ]
}

export interface ParsedQueuedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
}

export interface QueuedMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedQueuedMessageMentions
}

/**
 * 剥离 Electron `ipcRenderer.invoke` 给主进程错误加上的包装前缀：
 * `Error invoking remote method '<channel>': Error: <主进程文案>`。
 *
 * 主进程抛出的文案本身不带前缀，所以对 `error.message` 做锚定匹配会在真实 IPC 上永远失配
 * （同一前缀的剥离写法已存在于 FileBrowser.stripIpcErrorPrefix）。
 */
function stripIpcErrorPrefix(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

/** Main 已结束旧 run、renderer 尚未收到 complete 时，queue 可安全降级为新 run。 */
export function isQueueTargetNoLongerActiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^\[Agent 编排\] 会话未运行，无法追加消息: /.test(stripIpcErrorPrefix(error.message))
}

/** Main 确认本次请求未启动、同 session 的 owner run 仍在执行。 */
export function isAgentRunAlreadyActiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^AGENT_RUN_ALREADY_ACTIVE: /.test(stripIpcErrorPrefix(error.message))
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把纯文本队列消息转成与 RichTextInput 段落渲染一致的 HTML：
 * 双换行分段落，单换行转 <br>，并转义 HTML 特殊字符避免破坏结构。
 * 用于撤回时保留已有草稿的富文本节点（mention 等），同时让队列文本按正常段落显示。
 */
export function queuedTextToParagraphHtml(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  return normalized
    .split(/\n\n+/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}


const REF_PATTERN = /\/skill:(?<skill>\S+)|#mcp:(?<mcp>\S+)|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)\S+)?/g

export function parseQueuedMessageMentions(text: string): ParsedQueuedMessageMentions {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
  }

  return {
    cleanedText: text.replace(REF_PATTERN, '').trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds,
  }
}

export function buildQueuedMessageSendPayload(
  message: AgentQueuedMessage,
  quotedSelectionBlock = '',
): QueuedMessageSendPayload {
  const text = message.text.trim()
  const mentions = parseQueuedMessageMentions(text)
  const prefix = quotedSelectionBlock.trim().length > 0
    ? `${quotedSelectionBlock.trimEnd()}\n\n`
    : ''

  return {
    rawText: `${prefix}${text}`.trim(),
    sdkText: `${prefix}${mentions.cleanedText}`.trim(),
    mentions,
  }
}
