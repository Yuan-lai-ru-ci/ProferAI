/**
 * 运行中追加消息队列（纯数据操作，可单测）。
 *
 * 设计要点（2026-10-27 定稿）：
 * - 队列只回答「这条消息什么时候发」，不持有引用数据——引用已内联在正文里。
 * - 撤回是纯前端出队，不依赖主进程 `cancelQueuedMessage`（Pi 上那是空实现）。
 * - 自动发送的判定在 `agent-autosend-turn.ts`，这里只管队列本身。
 */

export type QueueDropPlacement = 'before' | 'after'

export interface AgentQueuedMessage {
  id: string
  /** 消息正文（含内联引用标记），入队时已 trim */
  text: string
  createdAt: number
}

export function createAgentQueuedMessage(text: string, id: string, createdAt: number): AgentQueuedMessage {
  return { id, text: text.trim(), createdAt }
}

export function removeQueuedMessage(queue: AgentQueuedMessage[], messageId: string): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== messageId)
}

/** in-flight 发送失败时，只有仍属于同一未停止 epoch 的消息才允许回队。 */
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

/**
 * 把队列消息的纯文本转成可塞进富文本编辑器的段落 HTML。
 *
 * 撤回时会拼到当前草稿后面，所以只需要转义 + 段落拆分，不做任何 Markdown 解释。
 */
export function queuedTextToParagraphHtml(text: string): string {
  const escapeHtml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  return text
    .split(/\n\n+/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}
