import type { KnowledgeItem, PaperMeta, PaperWorkbenchRecord } from '@profer/shared'

export type LibraryItem = KnowledgeItem | PaperMeta
export type LibrarySort = 'recent' | 'title' | 'favorite'
export type DisplayLibraryItem = LibraryItem & { workbench: PaperWorkbenchRecord }

export const EMPTY_WORKBENCH_RECORD: PaperWorkbenchRecord = { favorite: false, tags: [], note: '', readingProgress: 0, updatedAt: 0 }

function isKnowledgeItem(item: LibraryItem): item is KnowledgeItem {
  return 'kind' in item && typeof item.kind === 'string'
}

export function getItemOrigin(item: LibraryItem): 'local' | 'arxiv' { return isKnowledgeItem(item) ? item.origin : item.source }
export function getItemKind(item: LibraryItem): string { return isKnowledgeItem(item) ? item.kind : 'pdf' }
export function getItemAuthors(item: LibraryItem): string[] { return isKnowledgeItem(item) ? item.research?.authors || [] : item.authors || [] }
export function getItemSummary(item: LibraryItem): string { return isKnowledgeItem(item) ? item.research?.abstract || '' : item.abstract || '' }

export function toDisplayItems(items: LibraryItem[], records: Record<string, PaperWorkbenchRecord>): DisplayLibraryItem[] {
  return items.map((item) => ({ ...item, workbench: records[item.id] || EMPTY_WORKBENCH_RECORD }))
}

export function getAllWorkbenchTags(items: DisplayLibraryItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.workbench.tags))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function filterAndSortItems(items: DisplayLibraryItem[], options: { query: string; tag: string | null; favoritesOnly: boolean; sort: LibrarySort }): DisplayLibraryItem[] {
  const normalizedQuery = options.query.trim().toLocaleLowerCase()
  const filtered = items.filter((item) => {
    if (options.favoritesOnly && !item.workbench.favorite) return false
    if (options.tag && !item.workbench.tags.includes(options.tag)) return false
    if (!normalizedQuery) return true
    return [item.title, getItemAuthors(item).join(' '), getItemSummary(item), item.tags.join(' '), item.workbench.tags.join(' '), getItemKind(item)].join(' ').toLocaleLowerCase().includes(normalizedQuery)
  })
  return [...filtered].sort((left, right) => {
    if (options.sort === 'favorite' && left.workbench.favorite !== right.workbench.favorite) return Number(right.workbench.favorite) - Number(left.workbench.favorite)
    if (options.sort === 'title') return left.title.localeCompare(right.title, 'zh-CN')
    return right.importedAt - left.importedAt
  })
}

export function clampProgress(progress: number): number { return Math.max(0, Math.min(1, progress)) }
export function formatProgress(progress: number): string { return `${Math.round(clampProgress(progress) * 100)}%` }
