import { readMessageProvenance } from '@profer/shared'

/** 产品消息身份与 Provider UUID 分开保存；run 限定业务 ID，避免跨运行误合并。 */
export function getAgentMessageIdentity(message: { type?: unknown; uuid?: unknown; _provenance?: unknown }): string | undefined {
  if (typeof message.uuid === 'string' && message.uuid.length > 0) return JSON.stringify([message.type, 'uuid', message.uuid])
  const provenance = readMessageProvenance(message._provenance)
  if (provenance) return JSON.stringify([message.type, 'provenance', provenance.runId, provenance.messageId])
  return undefined
}
