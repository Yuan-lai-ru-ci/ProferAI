import type { ActorRef, MessageProvenance, ResourceRef } from '@profer/agent-fabric'

const ACTOR_TYPES = new Set<ActorRef['type']>(['user', 'agent', 'automation', 'external', 'system', 'unknown'])
const RESOURCE_TYPES = new Set<ResourceRef['type']>(['task', 'run', 'session', 'message', 'automation', 'request'])

function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.split('').some((char) => {
      const code = char.charCodeAt(0)
      return char === '/' || char === '\\' || code === 0 || code < 0x20 || code === 0x7f
    })
    && value !== '.'
    && value !== '..'
}

/** 只接受持久化层生成的完整来源事实；不从协议 role/type 推断作者。 */
export function readMessageProvenance(value: unknown): MessageProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const authorValue = record.author
  if (record.schemaVersion !== 1 || !isSafeOpaqueId(record.messageId) || !isSafeOpaqueId(record.runId)
    || !authorValue || typeof authorValue !== 'object') return undefined
  const author = authorValue as Record<string, unknown>
  if (!ACTOR_TYPES.has(author.type as ActorRef['type'])) return undefined
  if (author.id !== undefined && !isSafeOpaqueId(author.id)) return undefined

  let source: ResourceRef | undefined
  if (record.source !== undefined) {
    if (!record.source || typeof record.source !== 'object') return undefined
    const sourceRecord = record.source as Record<string, unknown>
    if (!RESOURCE_TYPES.has(sourceRecord.type as ResourceRef['type']) || !isSafeOpaqueId(sourceRecord.id)) return undefined
    source = { type: sourceRecord.type as ResourceRef['type'], id: sourceRecord.id }
  }

  return {
    schemaVersion: 1,
    messageId: record.messageId,
    author: { type: author.type as ActorRef['type'], ...(typeof author.id === 'string' ? { id: author.id } : {}) },
    runId: record.runId,
    ...(isSafeOpaqueId(record.taskId) ? { taskId: record.taskId } : {}),
    ...(isSafeOpaqueId(record.triggerId) ? { triggerId: record.triggerId } : {}),
    ...(source ? { source } : {}),
  }
}

/** 历史消息缺少可信 provenance 时显式投影为 unknown，不按 role/type 猜测。 */
export function getMessageAuthor(value: unknown): ActorRef {
  return readMessageProvenance(value)?.author ?? { type: 'unknown' }
}

/** Pocket/remote 只透传这份安全来源投影，不携带 authorization、凭据或原始路径。 */
export function projectMessageProvenance(value: unknown): MessageProvenance | undefined {
  return readMessageProvenance(value)
}
