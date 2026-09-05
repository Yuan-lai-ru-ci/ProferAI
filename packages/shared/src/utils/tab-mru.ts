/** 标签页最近使用（MRU）通用操作，供 renderer 与主进程复用。 */

const DEFAULT_MRU_LIMIT = 50

/** 将标签提升到最近使用队首，并去重、限制长度。 */
export function promoteMru(
  mru: readonly string[],
  tabId: string | null | undefined,
  limit = DEFAULT_MRU_LIMIT,
): string[] {
  if (!tabId) return [...mru]
  return [tabId, ...mru.filter((id) => id !== tabId)].slice(0, Math.max(1, limit))
}

/** 从 MRU 中移除已关闭标签。 */
export function removeMruId(mru: readonly string[], tabId: string | null | undefined): string[] {
  if (!tabId) return [...mru]
  return mru.filter((id) => id !== tabId)
}

/** 在仍存在的标签中选择最近访问目标；当前标签和失效记录会被跳过。 */
export function selectMruFallbackId(
  mru: readonly string[],
  activeTabId: string | null | undefined,
  availableIds: Iterable<string>,
): string | null {
  const available = new Set(availableIds)
  for (const id of mru) {
    if (id !== activeTabId && available.has(id)) return id
  }
  return null
}
