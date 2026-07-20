/**
 * Upserts an SDK message into the live transcript by UUID.
 *
 * Pi emits multiple `_partial` previews followed by a final message with the
 * same UUID. A partial on either side must be replaced with the incoming
 * message; only two final messages remain de-duplicated.
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
