/**
 * 将持久化与实时转录合并，同时以 type + uuid 为消息身份去重。
 *
 * 实时消息会覆盖同 UUID 的持久化副本，但保留该消息在持久化转录中的原有位置。
 * 这样切换会话后既不会重复渲染 `/compact`，也不会把 live 副本错误挪到对话末尾。
 */
export function mergeMessagesByUuid<T extends { type?: unknown; uuid?: unknown }>(
  persisted: readonly T[],
  live: readonly T[],
): T[] {
  const merged: T[] = []
  const indexByUuid = new Map<string, number>()

  const appendOrReplace = (message: T): void => {
    if (typeof message.uuid !== 'string' || message.uuid.length === 0) {
      merged.push(message)
      return
    }

    const key = `${String(message.type)}:${message.uuid}`
    const existingIndex = indexByUuid.get(key)
    if (existingIndex == null) {
      indexByUuid.set(key, merged.length)
      merged.push(message)
      return
    }

    // 新副本（特别是 live 的 partial/final）更新内容，但不改变原有时间顺序。
    merged[existingIndex] = message
  }

  persisted.forEach(appendOrReplace)
  live.forEach(appendOrReplace)
  return merged
}
