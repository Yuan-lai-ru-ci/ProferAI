import type { PaperMeta, PaperWorkbenchRecord } from '@profer/shared'

export type PaperSort = 'recent' | 'title' | 'year' | 'favorite'

export interface DisplayPaper extends PaperMeta {
  workbench: PaperWorkbenchRecord
}

export const EMPTY_WORKBENCH_RECORD: PaperWorkbenchRecord = {
  favorite: false,
  tags: [],
  note: '',
  readingProgress: 0,
  updatedAt: 0,
}

export function toDisplayPapers(
  papers: PaperMeta[],
  records: Record<string, PaperWorkbenchRecord>,
): DisplayPaper[] {
  return papers.map((paper) => ({
    ...paper,
    workbench: records[paper.id] || EMPTY_WORKBENCH_RECORD,
  }))
}

export function getAllWorkbenchTags(papers: DisplayPaper[]): string[] {
  return [...new Set(papers.flatMap((paper) => paper.workbench.tags))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function filterAndSortPapers(
  papers: DisplayPaper[],
  options: { query: string; tag: string | null; favoritesOnly: boolean; sort: PaperSort },
): DisplayPaper[] {
  const normalizedQuery = options.query.trim().toLocaleLowerCase()
  const filtered = papers.filter((paper) => {
    if (options.favoritesOnly && !paper.workbench.favorite) return false
    if (options.tag && !paper.workbench.tags.includes(options.tag)) return false
    if (!normalizedQuery) return true

    const searchable = [
      paper.title,
      paper.authors.join(' '),
      paper.abstract,
      paper.tags.join(' '),
      paper.workbench.tags.join(' '),
    ].join(' ').toLocaleLowerCase()
    return searchable.includes(normalizedQuery)
  })

  return [...filtered].sort((left, right) => {
    if (options.sort === 'favorite') {
      if (left.workbench.favorite !== right.workbench.favorite) {
        return Number(right.workbench.favorite) - Number(left.workbench.favorite)
      }
      return right.importedAt - left.importedAt
    }
    if (options.sort === 'title') return left.title.localeCompare(right.title, 'zh-CN')
    if (options.sort === 'year') return (right.year || 0) - (left.year || 0)
    return right.importedAt - left.importedAt
  })
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress))
}

export function formatProgress(progress: number): string {
  return `${Math.round(clampProgress(progress) * 100)}%`
}
