import { readMessageProvenance } from '@profer/shared'

/** 同身份新副本可更新内容/来源，但不能用迟到的接收时间移动已有消息。 */
export function preserveMessageCreatedAt<T extends { _createdAt?: unknown }>(existing: T, incoming: T): T {
  const createdAt = typeof existing._createdAt === 'number' && Number.isFinite(existing._createdAt)
    ? existing._createdAt : undefined
  if (incoming._createdAt === createdAt) return incoming
  // 无时间的历史沿用数组位置，不能被迟到副本的接收时间挪到回复之后。
  return { ...incoming, _createdAt: createdAt }
}

/** 产品消息身份与 Provider UUID 分开保存；run 限定业务 ID，避免跨运行误合并。 */
export function getAgentMessageIdentity(message: { type?: unknown; uuid?: unknown; _provenance?: unknown }): string | undefined {
  if (typeof message.uuid === 'string' && message.uuid.length > 0) return JSON.stringify([message.type, 'uuid', message.uuid])
  const provenance = readMessageProvenance(message._provenance)
  if (provenance) return JSON.stringify([message.type, 'provenance', provenance.runId, provenance.messageId])
  return undefined
}
