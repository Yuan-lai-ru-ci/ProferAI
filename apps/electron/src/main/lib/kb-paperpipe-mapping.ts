import type { PaperMeta } from '@profer/shared'

export interface RemotePaperLike {
  id: string
  title?: string
  authors?: unknown
  abstract?: string
  year?: number
  tags?: unknown
  arxivId?: string
  arxiv_id?: string
  source?: unknown
  added?: string
}

export interface RemotePaperContent {
  markdown?: unknown
  summary?: unknown
  equations?: unknown
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function resolveRemoteSource(value: unknown): PaperMeta['source'] | undefined {
  return value === 'local' || value === 'arxiv' ? value : undefined
}

/** 完整 Markdown 始终优先；摘要只用于正文缺失时的安全降级。 */
export function selectRemoteMarkdown(content: RemotePaperContent): string {
  const markdown = asText(content.markdown)
  if (markdown) return markdown
  const summary = asText(content.summary)
  return summary ? `# Summary\n\n${summary}` : ''
}

export function remotePaperToMeta(remote: RemotePaperLike, fallbackSource: PaperMeta['source'] = 'arxiv'): PaperMeta {
  const addedAt = Date.parse(asText(remote.added))
  const source = resolveRemoteSource(remote.source) ?? fallbackSource
  return {
    id: remote.id,
    remoteId: remote.id,
    title: asText(remote.title) || remote.id,
    authors: asStringList(remote.authors),
    abstract: asText(remote.abstract),
    arxivId: asText(remote.arxivId) || asText(remote.arxiv_id) || undefined,
    year: typeof remote.year === 'number' && Number.isFinite(remote.year) ? remote.year : undefined,
    source,
    pageCount: 0,
    importedAt: Number.isFinite(addedAt) ? addedAt : Date.now(),
    tags: asStringList(remote.tags),
    chunkCount: 0,
    syncState: 'synced',
  }
}

/**
 * 同一远端实体优先以 remoteId 合并；只有明确存在的 arXiv ID 可以作为次级键。
 */
export function findPaperMatch(papers: PaperMeta[], candidate: PaperMeta): number {
  return papers.findIndex((paper) =>
    (candidate.remoteId != null && paper.remoteId === candidate.remoteId)
    || paper.id === candidate.id
    || (candidate.arxivId != null && paper.arxivId === candidate.arxivId),
  )
}

/** 保留本地 PDF 的 identity 和本地内容关联，远端只补充已证实 metadata。 */
export function mergePaperMeta(current: PaperMeta | undefined, incoming: PaperMeta): PaperMeta {
  if (!current) return incoming
  if (current.source === 'local') {
    return {
      ...current,
      remoteId: current.remoteId ?? incoming.remoteId,
      syncState: current.remoteId || incoming.remoteId ? 'synced' : current.syncState,
      syncError: current.remoteId || incoming.remoteId ? undefined : current.syncError,
      title: current.title || incoming.title,
      authors: current.authors.length ? current.authors : incoming.authors,
      abstract: current.abstract || incoming.abstract,
      tags: current.tags.length ? current.tags : incoming.tags,
      year: current.year ?? incoming.year,
    }
  }
  return { ...current, ...incoming, id: current.id, remoteId: incoming.remoteId ?? current.remoteId }
}
