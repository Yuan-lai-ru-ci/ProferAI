import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowDownAZ,
  BookOpen,
  CheckSquare,
  ChevronLeft,
  CircleX,
  ExternalLink,
  FileText,
  Heart,
  Library,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ImportDialog } from './ImportDialog'
import { WindowControls } from '@/components/WindowControls'
import { markdownToHtml } from '@/lib/markdown-rich-text'
import { detectIsWindows } from '@/lib/platform'
import type {
  KBSearchResult,
  KBStats,
  KnowledgeBaseWorkbenchPatch,
  PaperMeta,
  PaperWorkbenchRecord,
} from '@profer/shared'
import {
  EMPTY_WORKBENCH_RECORD,
  filterAndSortPapers,
  formatProgress,
  getAllWorkbenchTags,
  toDisplayPapers,
  type PaperSort,
} from './knowledge-base-workbench-utils'

const SEARCH_RESULT_LIMIT = 16

type SelectedPaper = { meta: PaperMeta; markdown: string }

function IconButton({
  label,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function KnowledgeBasePanel() {
  const [papers, setPapers] = useState<PaperMeta[]>([])
  const [stats, setStats] = useState<KBStats>({ totalPapers: 0, totalChunks: 0, storageBytes: 0 })
  const [records, setRecords] = useState<Record<string, PaperWorkbenchRecord>>({})
  const [selectedPaper, setSelectedPaper] = useState<SelectedPaper | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [libraryQuery, setLibraryQuery] = useState('')
  const [semanticQuery, setSemanticQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KBSearchResult[] | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sort, setSort] = useState<PaperSort>('recent')
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [isSavingNote, setIsSavingNote] = useState(false)
  const [batchTagDraft, setBatchTagDraft] = useState('')
  const readerRef = useRef<HTMLDivElement>(null)
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isWindows = useMemo(() => detectIsWindows(), [])

  const loadWorkbench = useCallback(async (refresh = false) => {
    refresh ? setIsRefreshing(true) : setIsLoading(true)
    try {
      setLoadError(null)
      const [list, nextStats, workbench] = await Promise.all([
        window.electronAPI.kb.listPapers(),
        window.electronAPI.kb.getStats(),
        window.electronAPI.kb.getWorkbenchState(),
      ])
      setPapers(list)
      setStats(nextStats)
      setRecords(workbench.records)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法加载论文知识库'
      setLoadError(message)
      toast.error(message)
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkbench()
    return () => {
      if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current)
      if (progressSaveTimer.current) clearTimeout(progressSaveTimer.current)
    }
  }, [loadWorkbench])

  const displayPapers = useMemo(() => toDisplayPapers(papers, records), [papers, records])
  const allTags = useMemo(() => getAllWorkbenchTags(displayPapers), [displayPapers])
  const visiblePapers = useMemo(
    () => filterAndSortPapers(displayPapers, { query: libraryQuery, tag: tagFilter, favoritesOnly, sort }),
    [displayPapers, favoritesOnly, libraryQuery, sort, tagFilter],
  )
  const selectedRecord = selectedPaper ? records[selectedPaper.meta.id] || EMPTY_WORKBENCH_RECORD : null
  const selectedCount = selectedIds.size

  const updateRecord = useCallback(async (paperId: string, patch: KnowledgeBaseWorkbenchPatch) => {
    const previous = records[paperId] || EMPTY_WORKBENCH_RECORD
    const optimistic: PaperWorkbenchRecord = { ...previous, ...patch, updatedAt: Date.now() }
    setRecords((current) => ({ ...current, [paperId]: optimistic }))
    try {
      const persisted = await window.electronAPI.kb.updateWorkbenchRecord(paperId, patch)
      setRecords((current) => ({ ...current, [paperId]: persisted }))
      return persisted
    } catch (error) {
      setRecords((current) => ({ ...current, [paperId]: previous }))
      const message = error instanceof Error ? error.message : '保存个人标注失败'
      toast.error(message)
      throw error
    }
  }, [records])

  const selectPaper = useCallback(async (paperId: string) => {
    try {
      const paper = await window.electronAPI.kb.getPaper(paperId)
      if (!paper) {
        toast.error('论文不存在或已被删除')
        return
      }
      setSelectedPaper(paper)
      setSearchResults(null)
      setNoteDraft(records[paperId]?.note || '')
      requestAnimationFrame(() => {
        if (readerRef.current) {
          const progress = records[paperId]?.readingProgress || 0
          readerRef.current.scrollTop = (readerRef.current.scrollHeight - readerRef.current.clientHeight) * progress
        }
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载论文失败')
    }
  }, [records])

  const runSemanticSearch = useCallback(async () => {
    const query = semanticQuery.trim()
    if (!query) return
    setIsSearching(true)
    try {
      const results = await window.electronAPI.kb.search(query, SEARCH_RESULT_LIMIT)
      setSearchResults(results)
      setSelectedPaper(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '语义搜索失败')
    } finally {
      setIsSearching(false)
    }
  }, [semanticQuery])

  const deletePapers = useCallback(async (paperIds: string[]) => {
    if (!paperIds.length) return
    const targets = papers.filter((paper) => paperIds.includes(paper.id))
    const label = targets.length === 1 ? `「${targets[0]?.title || '这篇论文'}」` : `${targets.length} 篇论文`
    if (!window.confirm(`确定删除${label}吗？此操作会同时删除 paperpipe 中的论文，且不可恢复。`)) return

    const outcomes = await Promise.allSettled(paperIds.map((paperId) => window.electronAPI.kb.deletePaper(paperId)))
    const deletedIds = paperIds.filter((_, index) => {
      const outcome = outcomes[index]
      return outcome?.status === 'fulfilled' && outcome.value.localDeleted && outcome.value.remoteStatus !== 'failed'
    })
    const failedCount = paperIds.length - deletedIds.length
    if (deletedIds.length) {
      await window.electronAPI.kb.deleteWorkbenchRecords(deletedIds)
      setPapers((current) => current.filter((paper) => !deletedIds.includes(paper.id)))
      setRecords((current) => {
        const next = { ...current }
        deletedIds.forEach((id) => delete next[id])
        return next
      })
      setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.includes(id))))
      if (selectedPaper && deletedIds.includes(selectedPaper.meta.id)) setSelectedPaper(null)
    }
    if (failedCount) toast.error(`${failedCount} 篇论文删除失败，其余已删除`)
    else toast.success(`已删除 ${deletedIds.length} 篇论文`)
    void loadWorkbench(true)
  }, [loadWorkbench, papers, selectedPaper])

  const toggleSelection = (paperId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      next.has(paperId) ? next.delete(paperId) : next.add(paperId)
      return next
    })
  }

  const toggleFavorite = async (paperId: string, nextFavorite?: boolean) => {
    const favorite = nextFavorite ?? !(records[paperId]?.favorite || false)
    await updateRecord(paperId, { favorite })
  }

  const addTag = async (paperId: string, tag: string) => {
    const normalized = tag.trim()
    if (!normalized) return
    const currentTags = records[paperId]?.tags || []
    if (currentTags.includes(normalized)) return
    await updateRecord(paperId, { tags: [...currentTags, normalized] })
  }

  const removeTag = async (paperId: string, tag: string) => {
    await updateRecord(paperId, { tags: (records[paperId]?.tags || []).filter((item) => item !== tag) })
  }

  const scheduleNoteSave = (value: string) => {
    setNoteDraft(value)
    if (!selectedPaper) return
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current)
    setIsSavingNote(true)
    const paperId = selectedPaper.meta.id
    noteSaveTimer.current = setTimeout(() => {
      void updateRecord(paperId, { note: value }).finally(() => setIsSavingNote(false))
    }, 650)
  }

  const onReaderScroll = () => {
    if (!selectedPaper || !readerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = readerRef.current
    const maxScroll = Math.max(1, scrollHeight - clientHeight)
    const readingProgress = Math.max(0, Math.min(1, scrollTop / maxScroll))
    if (progressSaveTimer.current) clearTimeout(progressSaveTimer.current)
    const paperId = selectedPaper.meta.id
    progressSaveTimer.current = setTimeout(() => {
      void updateRecord(paperId, { readingProgress }).catch(() => undefined)
    }, 700)
  }

  const applyBatchFavorite = async (favorite: boolean) => {
    await Promise.all([...selectedIds].map((paperId) => updateRecord(paperId, { favorite })))
    toast.success(favorite ? '已收藏所选论文' : '已取消收藏所选论文')
  }

  const applyBatchTag = async () => {
    const tag = batchTagDraft.trim()
    if (!tag || !selectedIds.size) return
    await Promise.all([...selectedIds].map((paperId) => addTag(paperId, tag)))
    setBatchTagDraft('')
    toast.success(`已为 ${selectedIds.size} 篇论文添加标签`)
  }

  const clearSearchResults = () => {
    setSemanticQuery('')
    setSearchResults(null)
  }

  const renderSearchResults = () => {
    if (!searchResults) return null
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">语义搜索结果</p>
              <p className="mt-0.5 text-xs text-muted-foreground">“{semanticQuery}” 共 {searchResults.length} 条</p>
            </div>
            <button type="button" onClick={clearSearchResults} className="text-xs text-muted-foreground hover:text-foreground">返回论文库</button>
          </div>
          {searchResults.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Search className="size-8 opacity-35" />
              <p className="text-sm">没有找到相关内容</p>
            </div>
          ) : searchResults.map((result, index) => (
            <button
              type="button"
              key={`${result.paper.id}-${index}`}
              onClick={() => void selectPaper(result.paper.id)}
              className="w-full rounded-md border border-border/60 p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
            >
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{result.paper.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {result.paper.authors.slice(0, 3).join(', ') || '作者未知'}
                    {result.paper.year ? ` · ${result.paper.year}` : ''}
                  </p>
                  <p className="mt-3 line-clamp-4 text-sm leading-6 text-foreground/75">{result.chunk.content}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    )
  }

  const renderReader = () => {
    if (!selectedPaper) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <BookOpen className="size-10 opacity-30" />
          <div>
            <p className="text-sm font-medium text-foreground">选择一篇论文开始阅读</p>
            <p className="mt-1 text-xs">搜索、筛选或从左侧论文库中选择</p>
          </div>
        </div>
      )
    }

    const { meta, markdown } = selectedPaper
    const progress = selectedRecord?.readingProgress || 0
    return (
      <div ref={readerRef} onScroll={onReaderScroll} className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl px-6 py-7">
          <div className="mb-6 border-b border-border/60 pb-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold leading-7 text-foreground">{meta.title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{meta.authors.join(', ') || '作者未知'}</p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {meta.year ? <span className="rounded bg-accent px-2 py-1 text-xs text-muted-foreground">{meta.year}</span> : null}
                  <span className="rounded bg-accent px-2 py-1 text-xs text-muted-foreground">
                    {meta.source === 'arxiv' ? 'arXiv' : '本地 PDF'}
                  </span>
                  {meta.arxivId ? (
                    <button type="button" onClick={() => void window.electronAPI.openExternal(`https://arxiv.org/abs/${meta.arxivId}`)} className="inline-flex items-center gap-1 rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
                      arXiv:{meta.arxivId}<ExternalLink className="size-3" />
                    </button>
                  ) : null}
                  {meta.doi ? (
                    <button type="button" onClick={() => void window.electronAPI.openExternal(`https://doi.org/${meta.doi}`)} className="inline-flex items-center gap-1 rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
                      DOI<ExternalLink className="size-3" />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <IconButton label={selectedRecord?.favorite ? '取消收藏' : '收藏论文'} onClick={() => void toggleFavorite(meta.id)} className={selectedRecord?.favorite ? 'text-rose-500 hover:text-rose-600' : undefined}>
                  <Heart className={cn('size-4', selectedRecord?.favorite && 'fill-current')} />
                </IconButton>
                <IconButton label="删除论文" onClick={() => void deletePapers([meta.id])} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </div>
            {meta.abstract ? <p className="mt-4 text-sm leading-6 text-muted-foreground">{meta.abstract}</p> : null}
            <div className="mt-4 h-1 overflow-hidden rounded bg-accent">
              <div className="h-full bg-primary transition-[width]" style={{ width: formatProgress(progress) }} />
            </div>
          </div>
          {markdown ? (
            <div
              className="prose prose-sm max-w-none overflow-x-auto text-foreground/85 [&_pre]:bg-accent/60 [&_code]:bg-accent/40 [&_code]:text-foreground/85 [&_pre>code]:bg-transparent"
              dangerouslySetInnerHTML={{ __html: markdownToHtml(markdown) }}
            />
          ) : (
            <div className="rounded-md border border-dashed border-border/70 p-5 text-sm text-muted-foreground">该论文尚未同步可阅读的正文内容。</div>
          )}
        </article>
      </div>
    )
  }

  const renderPersonalPanel = () => {
    if (!selectedPaper) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-muted-foreground">
          <PencilLine className="size-6 opacity-35" />
          <p className="text-xs">选择论文后可记录笔记、标签和阅读进度</p>
        </div>
      )
    }
    const record = selectedRecord || EMPTY_WORKBENCH_RECORD
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/60 px-4 py-3">
          <p className="text-xs font-medium text-foreground">个人工作区</p>
          <p className="mt-1 text-[11px] text-muted-foreground">仅保存在当前设备</p>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-4">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium">阅读进度</p>
                <span className="text-xs text-muted-foreground">{formatProgress(record.readingProgress)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-accent"><div className="h-full bg-primary" style={{ width: formatProgress(record.readingProgress) }} /></div>
            </section>
            <section>
              <p className="mb-2 text-xs font-medium">个人标签</p>
              <div className="flex flex-wrap gap-1.5">
                {record.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 rounded bg-primary/10 py-1 pl-2 pr-1 text-[11px] text-primary">
                    {tag}
                    <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => void removeTag(selectedPaper.meta.id, tag)} className="rounded p-0.5 hover:bg-primary/15"><X className="size-3" /></button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex gap-1.5">
                <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addTag(selectedPaper.meta.id, tagDraft).then(() => setTagDraft('')) } }} placeholder="添加标签" className="h-7 min-w-0 flex-1 rounded border border-border/60 bg-transparent px-2 text-xs outline-none focus:border-primary/50" />
                <IconButton label="添加标签" onClick={() => void addTag(selectedPaper.meta.id, tagDraft).then(() => setTagDraft(''))}><Plus className="size-3.5" /></IconButton>
              </div>
            </section>
            <section className="min-h-[220px]">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium">阅读笔记</p>
                <span className="text-[10px] text-muted-foreground">{isSavingNote ? '保存中...' : '自动保存'}</span>
              </div>
              <Textarea value={noteDraft} onChange={(event) => scheduleNoteSave(event.target.value)} placeholder="记录问题、结论与后续想法..." className="min-h-[220px] resize-none text-xs leading-5" />
            </section>
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="relative z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <div className={cn('pointer-events-none absolute inset-0 titlebar-drag-region', isWindows && 'right-[118px]')} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {searchResults ? <IconButton label="返回论文库" onClick={clearSearchResults}><ChevronLeft className="size-4" /></IconButton> : <Library className="size-4 text-muted-foreground" />}
          <h1 className="truncate text-sm font-semibold">论文知识库</h1>
          {!isLoading ? <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">{papers.length}</span> : null}
        </div>
        <div className="titlebar-no-drag flex shrink-0 items-center gap-1.5">
          <div className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-border/60 bg-content-area px-2 focus-within:border-primary/45">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input value={semanticQuery} onChange={(event) => setSemanticQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSemanticSearch() }} placeholder="语义搜索论文" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70" />
          </div>
          <button type="button" onClick={() => void runSemanticSearch()} disabled={isSearching || !semanticQuery.trim()} className="flex h-7 items-center gap-1 rounded-md border border-border/60 px-2 text-xs hover:bg-accent disabled:opacity-40">
            {isSearching ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}搜索
          </button>
          <IconButton label="刷新论文库" onClick={() => void loadWorkbench(true)} disabled={isRefreshing}>{isRefreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}</IconButton>
          <button type="button" onClick={() => setIsImportOpen(true)} className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"><Plus className="size-3.5" />导入</button>
        </div>
        <WindowControls variant="inline" className="titlebar-no-drag -mr-1 ml-1" />
      </header>

      {loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <CircleX className="size-8 text-destructive/70" />
          <div><p className="text-sm font-medium">论文知识库加载失败</p><p className="mt-1 text-xs text-muted-foreground">{loadError}</p></div>
          <button type="button" onClick={() => void loadWorkbench()} className="rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">重试</button>
        </div>
      ) : isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : papers.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Library className="size-10 text-muted-foreground/40" />
          <div><p className="text-sm font-medium">论文知识库为空</p><p className="mt-1 text-xs text-muted-foreground">从 arXiv 导入或添加本地 PDF，建立自己的阅读库。</p></div>
          <button type="button" onClick={() => setIsImportOpen(true)} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"><Plus className="size-3.5" />导入第一篇论文</button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-border/60 bg-content-area/30">
            <div className="space-y-2 border-b border-border/60 p-3">
              <div className="flex h-8 items-center gap-2 rounded-md border border-border/60 bg-background px-2 focus-within:border-primary/45"><Search className="size-3.5 text-muted-foreground" /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="筛选论文、作者、标签" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />{libraryQuery ? <button type="button" onClick={() => setLibraryQuery('')}><X className="size-3.5 text-muted-foreground" /></button> : null}</div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setFavoritesOnly((value) => !value)} className={cn('flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]', favoritesOnly ? 'border-rose-300 bg-rose-500/10 text-rose-600' : 'border-border/60 text-muted-foreground hover:bg-accent')}><Star className={cn('size-3', favoritesOnly && 'fill-current')} />收藏</button>
                <div className="relative flex-1"><select value={sort} onChange={(event) => setSort(event.target.value as PaperSort)} className="h-7 w-full appearance-none rounded-md border border-border/60 bg-background px-2 pr-6 text-[11px] text-muted-foreground outline-none"><option value="recent">最近导入</option><option value="title">标题 A-Z</option><option value="year">发表年份</option><option value="favorite">收藏优先</option></select><ArrowDownAZ className="pointer-events-none absolute right-2 top-2 size-3 text-muted-foreground" /></div>
              </div>
              {allTags.length ? <div className="flex flex-wrap gap-1">{allTags.slice(0, 8).map((tag) => <button key={tag} type="button" onClick={() => setTagFilter((current) => current === tag ? null : tag)} className={cn('rounded px-1.5 py-1 text-[10px]', tagFilter === tag ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground hover:text-foreground')}>{tag}</button>)}{tagFilter ? <button type="button" onClick={() => setTagFilter(null)} className="text-[10px] text-muted-foreground hover:text-foreground">清除</button> : null}</div> : null}
            </div>
            {selectedCount > 0 ? <div className="flex items-center gap-1 border-b border-border/60 bg-primary/5 px-2 py-1.5"><span className="mr-auto text-[11px] text-muted-foreground">已选 {selectedCount}</span><IconButton label="收藏所选" onClick={() => void applyBatchFavorite(true)}><Heart className="size-3.5" /></IconButton><div className="flex items-center rounded border border-border/60 bg-background"><input value={batchTagDraft} onChange={(event) => setBatchTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void applyBatchTag() }} placeholder="标签" className="h-6 w-14 bg-transparent px-1.5 text-[10px] outline-none" /><button type="button" onClick={() => void applyBatchTag()} className="px-1"><Plus className="size-3" /></button></div><IconButton label="删除所选" onClick={() => void deletePapers([...selectedIds])} className="text-destructive hover:text-destructive"><Trash2 className="size-3.5" /></IconButton><IconButton label="取消选择" onClick={() => setSelectedIds(new Set())}><X className="size-3.5" /></IconButton></div> : null}
            <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground"><span>{visiblePapers.length} / {papers.length} 篇</span><span>{stats.totalChunks ? `${stats.totalChunks} 分块` : '个人工作台'}</span></div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="pb-2">
                {visiblePapers.map((paper) => <div key={paper.id} className={cn('group flex cursor-pointer gap-2 border-l-2 px-2 py-2.5 transition-colors hover:bg-accent/60', selectedPaper?.meta.id === paper.id ? 'border-primary bg-accent' : 'border-transparent')} onClick={() => void selectPaper(paper.id)}>
                  <button type="button" aria-label={`选择 ${paper.title}`} onClick={(event) => { event.stopPropagation(); toggleSelection(paper.id) }} className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary">{selectedIds.has(paper.id) ? <CheckSquare className="size-3.5 text-primary" /> : <span className="block size-3.5 rounded-sm border border-border/80" />}</button>
                  <div className="min-w-0 flex-1"><div className="flex items-start gap-1"><p className="line-clamp-2 flex-1 text-xs font-medium leading-4 text-foreground/90">{paper.title}</p>{paper.workbench.favorite ? <Heart className="mt-0.5 size-3 shrink-0 fill-rose-500 text-rose-500" /> : null}</div><p className="mt-1 truncate text-[10px] text-muted-foreground">{paper.authors.slice(0, 2).join(', ') || '作者未知'}{paper.year ? ` · ${paper.year}` : ''}</p>{paper.workbench.tags.length ? <div className="mt-1.5 flex gap-1 overflow-hidden">{paper.workbench.tags.slice(0, 2).map((tag) => <span key={tag} className="truncate rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">{tag}</span>)}</div> : null}{paper.workbench.readingProgress > 0 ? <div className="mt-2 h-px bg-border"><div className="h-full bg-primary" style={{ width: formatProgress(paper.workbench.readingProgress) }} /></div> : null}</div>
                </div>)}
                {!visiblePapers.length ? <div className="px-4 py-10 text-center text-xs text-muted-foreground">没有匹配的论文</div> : null}
              </div>
            </ScrollArea>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">{searchResults ? renderSearchResults() : renderReader()}</main>
          <aside className="hidden w-[280px] shrink-0 border-l border-border/60 bg-content-area/20 lg:block">{renderPersonalPanel()}</aside>
        </div>
      )}
      <ImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} onImportComplete={() => { setIsImportOpen(false); void loadWorkbench(true) }} />
    </div>
  )
}
