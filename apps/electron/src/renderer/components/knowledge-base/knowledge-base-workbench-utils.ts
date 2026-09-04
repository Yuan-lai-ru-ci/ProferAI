import type { KnowledgeItem } from '@profer/shared'

export type LibraryItem = KnowledgeItem
export type LibrarySort = 'recent' | 'title'
export type DisplayLibraryItem = KnowledgeItem

export function getItemOrigin(item: LibraryItem): 'local' | 'arxiv' { return item.origin }
export function getItemKind(item: LibraryItem): string { return item.kind }
export function getItemAuthors(item: LibraryItem): string[] { return item.research?.authors || [] }
export function getItemSummary(item: LibraryItem): string { return item.research?.abstract || '' }

export function toDisplayItems(items: KnowledgeItem[]): DisplayLibraryItem[] {
  return items
}

export function filterAndSortItems(items: DisplayLibraryItem[], options: { query: string; sort: LibrarySort }): DisplayLibraryItem[] {
  const normalizedQuery = options.query.trim().toLocaleLowerCase()
  const filtered = items.filter((item) => {
    if (!normalizedQuery) return true
    return [item.title, getItemAuthors(item).join(' '), getItemSummary(item), item.tags.join(' '), getItemKind(item)].join(' ').toLocaleLowerCase().includes(normalizedQuery)
  })
  return [...filtered].sort((left, right) => {
    if (options.sort === 'title') return left.title.localeCompare(right.title, 'zh-CN')
    return right.importedAt - left.importedAt
  })
}
