/** Chat 与 Agent 分开命名，消息ID/runId仍由所属Core原样保存。 */
export function namespaceCoreChatId(conversationId: string, coreId: string): string {
  return `core-chat:${encodeURIComponent(coreId)}:${conversationId}`
}
export function parseCoreChatId(value: string): { coreId: string; conversationId: string } | null {
  const match = /^core-chat:([^:]+):([^:]+)$/.exec(value)
  if (!match) return null
  try { return { coreId: decodeURIComponent(match[1]!), conversationId: match[2]! } } catch { return null }
}
export const FILE_PREFIX = 'core-chat-file:'
export function namespaceCoreChatFile(path: string, coreId: string): string {
  return `${FILE_PREFIX}${encodeURIComponent(coreId)}:${encodeURIComponent(path)}`
}
export function decodeFile(value: string, coreId: string): string {
  const match = /^core-chat-file:([^:]+):(.+)$/.exec(value)
  if (!match) throw new Error('Chat附件所属Core与当前目标不一致')
  try {
    if (decodeURIComponent(match[1]!) !== coreId) throw new Error('Chat附件所属Core与当前目标不一致')
    return decodeURIComponent(match[2]!)
  } catch { throw new Error('Chat附件所属Core与当前目标不一致') }
}


/** 仅转换附件路径，不碰消息ID、分支ID、普通正文及模型输出。 */
export function mapAttachments(value: unknown, coreId: string, inbound: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => mapAttachments(item, coreId, inbound))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
    key === 'localPath' && typeof item === 'string' && typeof record.mediaType === 'string'
      ? inbound ? decodeFile(item, coreId) : namespaceCoreChatFile(item, coreId)
      : mapAttachments(item, coreId, inbound)]))
}

export function projectCoreChatEvent(event: { conversationId: string; channel: string; payload: unknown }, coreId: string): { conversationId: string; channel: string; payload: unknown } {
  const conversationId = namespaceCoreChatId(event.conversationId, coreId)
  const payload = mapAttachments(event.payload, coreId, false)
  return { conversationId, channel: event.channel, payload: payload && typeof payload === 'object' ? { ...payload, conversationId } : payload }
}
