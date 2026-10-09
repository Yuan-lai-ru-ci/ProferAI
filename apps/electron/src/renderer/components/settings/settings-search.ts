/** 设置导航搜索的纯逻辑，供设置面板和单元测试复用。 */

export interface SettingsSearchEntry {
  label: string
  searchTerms?: readonly string[]
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '')
}

/**
 * 页面名称之外，允许用页面内的具体配置名称找到所属设置页。
 * 查询词按空白分隔时要求全部命中；中文短语则按整体连续匹配。
 */
export function matchesSettingsSearch(
  entry: SettingsSearchEntry,
  groupTitle: string | undefined,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim()
  if (!query) return true

  const searchableText = [groupTitle, entry.label, ...(entry.searchTerms ?? [])]
    .filter(Boolean)
    .join(' ')
  const searchable = normalizeSearchText(searchableText)
  const queryTerms = query.split(/\s+/).map(normalizeSearchText).filter(Boolean)
  if (queryTerms.length > 1 && queryTerms.every((term) => searchable.includes(term))) return true

  return searchable.includes(normalizeSearchText(query))
}
