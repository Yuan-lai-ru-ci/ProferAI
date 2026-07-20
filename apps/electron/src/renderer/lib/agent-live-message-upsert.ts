/**
 * 将实时 SDK 消息按 UUID 写入当前会话转录。
 *
 * Pi 会为同一助手回复持续发送 `_partial` 累计帧，最后再发送同 UUID 的 final。
 * 因此不能沿用“UUID 相同即丢弃”的队列消息去重规则：任一侧为 partial 时，
 * 必须以最新帧覆盖；只有 final → final 才保持去重。
 */
export type LiveMessageWithUuid = {
  uuid?: unknown
  _partial?: unknown
}

function asLiveMessageWithUuid(message: object): LiveMessageWithUuid {
  return message as LiveMessageWithUuid
}

export function upsertLiveMessageByUuid<T extends object>(
  current: readonly T[],
  incoming: T,
): T[] {
  const incomingRecord = asLiveMessageWithUuid(incoming)
  const incomingUuid = typeof incomingRecord.uuid === 'string' ? incomingRecord.uuid : undefined
  if (!incomingUuid) return [...current, incoming]

  const existingIndex = current.findIndex(
    (message) => asLiveMessageWithUuid(message).uuid === incomingUuid,
  )
  if (existingIndex < 0) return [...current, incoming]

  const existingMessage = current[existingIndex]
  if (!existingMessage) return [...current, incoming]
  const existing = asLiveMessageWithUuid(existingMessage)
  if (incomingRecord._partial === true || existing._partial === true) {
    const next = [...current]
    next[existingIndex] = incoming
    return next
  }

  return current as T[]
}
