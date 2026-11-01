import { getAgentMessageIdentity } from './agent-message-identity'

/**
 * 渲染前把消息数组归一化成「按时间有序、产品身份唯一」。
 *
 * 为什么要做这一层：渲染层的数组来自三处拼接——持久化分页（`[...earlier, ...current]`）、
 * 实时副本（`mergeMessagesByUuid`）、外置内容覆盖。任一处游标错位，数组就可能出现
 * 「后一段排在前一段前面」或「同一条消息出现两次」。
 *
 * 分组逻辑（groupIntoTurns）只看顺序：乱序会让「较晚的一段」先成为 turn 的 target，
 * 头图时间取自它，较早的一段随后被合并进来——表现就是**一条用户消息被拆成两个模型头像**，
 * 且上面那个头像是中间某个时刻。按时间排好序 + 去重之后，这类切块不会发生。
 *
 * 纯函数，便于测试：不依赖 React，也不修改入参。
 */
export interface TranscriptMessageLike {
  type?: unknown
  uuid?: unknown
  _provenance?: unknown
  _createdAt?: unknown
}

/** 有 uuid 的消息按 `type:uuid` 去重：保留最后一次出现的内容、第一次出现的位置。 */
function dedupeByUuid<T extends TranscriptMessageLike>(messages: readonly T[]): T[] {
  const merged: T[] = []
  const indexByKey = new Map<string, number>()
  for (const message of messages) {
    const key = getAgentMessageIdentity(message)
    if (!key) {
      merged.push(message)
      continue
    }
    const existing = indexByKey.get(key)
    if (existing === undefined) {
      indexByKey.set(key, merged.length)
      merged.push(message)
    } else {
      merged[existing] = message
    }
  }
  return merged
}

/**
 * 稳定排序：有 `_createdAt` 的按时间排；没有时间戳的消息沿用前一条的键，
 * 保持它在原数组里的相对位置（system / result 等可能没有时间戳）。
 */
function sortByCreatedAt<T extends TranscriptMessageLike>(messages: readonly T[]): T[] {
  const keyed = messages.map((message, index) => ({
    message,
    index,
    createdAt: typeof message._createdAt === 'number' ? message._createdAt : null as number | null,
  }))
  let lastKey = 0
  for (const item of keyed) {
    if (item.createdAt === null) {
      item.createdAt = lastKey
    } else {
      lastKey = item.createdAt
    }
  }
  keyed.sort((a, b) => ((a.createdAt as number) - (b.createdAt as number)) || (a.index - b.index))
  return keyed.map((item) => item.message)
}

/**
 * 归一化入口。数组本来就干净时返回**同一个引用**，避免下游 useMemo 无谓失效。
 */
export function orderTranscriptMessages<T extends TranscriptMessageLike>(messages: readonly T[]): readonly T[] {
  if (messages.length <= 1) return messages
  const deduped = dedupeByUuid(messages)
  const sorted = sortByCreatedAt(deduped)

  if (sorted.length === messages.length) {
    let same = true
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== messages[index]) { same = false; break }
    }
    if (same) return messages
  }
  return sorted
}
