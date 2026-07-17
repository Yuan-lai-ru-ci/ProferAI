/**
 * 知识库主面板
 *
 * 论文管理 + 语义搜索 + 导入。
 * 左侧论文列表，右侧论文详情/搜索结果。
 * 顶栏对齐 TeamWorkspaceView 工作区风格：h-11 紧凑横排 + 内嵌 WindowControls。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Search, Plus, Library, Trash2, FileText, Loader2, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ImportDialog } from './ImportDialog'
import { WindowControls } from '@/components/WindowControls'
import { markdownToHtml } from '@/lib/markdown-rich-text'
import { detectIsWindows } from '@/lib/platform'
import type { PaperMeta, KBSearchResult, KBStats } from '@profer/shared'

export function KnowledgeBasePanel() {
  const [papers, setPapers] = useState<PaperMeta[]>([])
  const [selectedPaper, setSelectedPaper] = useState<{ meta: PaperMeta; markdown: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KBSearchResult[] | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [stats, setStats] = useState<KBStats>({ totalPapers: 0, totalChunks: 0, storageBytes: 0 })
  const [loading, setLoading] = useState(true)

  const loadPapers = useCallback(async () => {
    try {
      const list = await window.electronAPI.kb.listPapers()
      setPapers(list)
      const s = await window.electronAPI.kb.getStats()
      setStats(s)
    } catch (err) {
      console.error('[KB Panel] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPapers()
  }, [loadPapers])

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null)
      return
    }
    setIsSearching(true)
    try {
      const results = await window.electronAPI.kb.search(searchQuery.trim(), 10)
      setSearchResults(results)
      setSelectedPaper(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '搜索失败'
      toast.error(msg)
    } finally {
      setIsSearching(false)
    }
  }

  const handleSelectPaper = async (paperId: string) => {
    try {
      const paper = await window.electronAPI.kb.getPaper(paperId)
      setSelectedPaper(paper)
      setSearchResults(null)
    } catch {
      toast.error('加载论文失败')
    }
  }

  const handleDelete = async (paperId: string, title: string) => {
    if (!confirm(`确定删除「${title}」吗？此操作不可恢复。`)) return
    try {
      await window.electronAPI.kb.deletePaper(paperId)
      toast.success('已删除')
      setSelectedPaper(null)
      loadPapers()
    } catch {
      toast.error('删除失败')
    }
  }

  const handleImportComplete = () => {
    setIsImportOpen(false)
    loadPapers()
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const isWindows = useMemo(() => detectIsWindows(), [])

  // ---- 搜索结果视图 ----
  const renderSearchResults = () => {
    if (!searchResults) return null
    if (searchResults.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p className="text-sm">未找到相关论文内容</p>
        </div>
      )
    }
    return (
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-6">
          <h3 className="text-sm font-medium text-muted-foreground">
            搜索结果 ({searchResults.length})
          </h3>
          {searchResults.map((r, i) => (
            <button
              key={`${r.paper.id}-${i}`}
              className="w-full text-left p-3 rounded-lg border border-border/60 hover:border-primary/40 hover:bg-accent/40 transition-colors"
              onClick={() => handleSelectPaper(r.paper.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.paper.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {r.paper.authors.slice(0, 3).join(', ')}
                    {r.paper.authors.length > 3 && ' 等'}
                    {r.paper.year ? ` (${r.paper.year})` : ''}
                  </p>
                  {r.chunk.sectionTitle && (
                    <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground">
                      {r.chunk.sectionTitle}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                  {Math.round(r.score * 100)}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 line-clamp-3">
                {r.chunk.content.slice(0, 300)}
              </p>
            </button>
          ))}
        </div>
      </ScrollArea>
    )
  }

  // ---- 论文详情视图 ----
  const renderPaperDetail = () => {
    if (!selectedPaper) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
          <Library className="size-12 opacity-30" />
          <p className="text-sm">选择一篇论文查看详情</p>
        </div>
      )
    }
    const { meta } = selectedPaper
    return (
      <ScrollArea className="flex-1">
        <div className="p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground">{meta.title}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {meta.authors.join(', ')}
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {meta.year && (
                  <span className="text-xs px-2 py-0.5 rounded-md bg-accent">{meta.year}</span>
                )}
                {meta.arxivId && (
                  <a
                    href={`https://arxiv.org/abs/${meta.arxivId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-0.5 rounded-md border border-border/60 bg-content-area hover:bg-foreground/[0.04] inline-flex items-center gap-1 transition-colors"
                  >
                    arXiv:{meta.arxivId} <ExternalLink className="size-3" />
                  </a>
                )}
                {meta.doi && (
                  <a
                    href={`https://doi.org/${meta.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-0.5 rounded-md border border-border/60 bg-content-area hover:bg-foreground/[0.04] inline-flex items-center gap-1 transition-colors"
                  >
                    DOI <ExternalLink className="size-3" />
                  </a>
                )}
                <span className="text-xs px-2 py-0.5 rounded-md bg-accent text-muted-foreground">
                  {meta.pageCount} 页 · {meta.chunkCount} 分块
                </span>
              </div>
              {meta.abstract && (
                <p className="text-sm text-muted-foreground mt-3 line-clamp-6">
                  {meta.abstract}
                </p>
              )}
            </div>
            <button
              type="button"
              className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              onClick={() => handleDelete(meta.id, meta.title)}
            >
              <Trash2 className="size-4" />
            </button>
          </div>

          <hr className="my-4 border-border/60" />

          <div
            className="prose prose-sm max-w-none overflow-x-auto text-foreground/85 [&_pre]:bg-accent/60 [&_code]:bg-accent/40 [&_code]:text-foreground/85 [&_pre>code]:bg-transparent"
            dangerouslySetInnerHTML={{ __html: selectedMarkdownHtml }}
          />
        </div>
      </ScrollArea>
    )
  }

  const selectedMarkdownHtml = useMemo(
    () => (selectedPaper ? markdownToHtml(selectedPaper.markdown) : ''),
    [selectedPaper],
  )

  const showEmptyState = !loading && papers.length === 0

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 标题栏 — 工作区风格：h-11 紧凑横排 + 内嵌 WindowControls */}
      <div className="relative z-10 flex h-11 items-center gap-2 border-b border-border/50 bg-background px-3 flex-shrink-0">
        <div className={cn('pointer-events-none absolute inset-0 titlebar-drag-region', isWindows && 'right-[118px]')} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Library className="size-3.5 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-semibold text-foreground">知识库</h1>
        </div>
        {!showEmptyState && (
          <div className="titlebar-no-drag flex shrink-0 items-center gap-1.5 overflow-visible whitespace-nowrap">
            {/* 搜索框 */}
            <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-content-area px-2 transition-colors focus-within:border-primary/40">
              <Search className="size-3 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="语义搜索论文..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none w-[160px]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setSearchResults(null) }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <span className="text-xs">×</span>
                </button>
              )}
            </div>
            {/* 搜索按钮 */}
            <button
              type="button"
              onClick={handleSearch}
              disabled={isSearching || !searchQuery.trim()}
              className="flex h-7 items-center gap-1 rounded-md border border-border/60 bg-content-area px-2 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.04] disabled:opacity-40"
            >
              {isSearching ? <Loader2 className="size-3 animate-spin" /> : null}
              搜索
            </button>
            {/* 导入按钮 */}
            <button
              type="button"
              onClick={() => setIsImportOpen(true)}
              className="flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[12px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              <Plus size={13} />
              导入论文
            </button>
          </div>
        )}
        <WindowControls variant="inline" className="titlebar-no-drag -mr-1 ml-1" />
      </div>

      {/* 空状态 — 对齐 AutomationsListView EmptyState */}
      {showEmptyState ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/40">
            <Library className="size-6 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">知识库为空</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[280px]">
              导入论文 PDF 或从 arXiv 搜索导入，MinerU 会自动解析并建立索引
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsImportOpen(true)}
            className="titlebar-no-drag mt-1 flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Plus size={14} />
            导入第一篇论文
          </button>
        </div>
      ) : (
        /* 正文内容 */
        <div className="flex flex-1 min-h-0 max-w-6xl w-full mx-auto px-8 pb-8">
          {/* 左侧论文列表 */}
          <div className="w-64 shrink-0 border border-border/60 rounded-lg flex flex-col mr-6 overflow-hidden">
            <div className="px-3 py-2.5 border-b border-border/60 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                共 {papers.length} 篇
              </p>
              <p className="text-[10px] text-muted-foreground/60">
                {formatBytes(stats.storageBytes)}
              </p>
            </div>
            <ScrollArea className="flex-1">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="py-1">
                  {papers.map((paper) => (
                    <button
                      key={paper.id}
                      className={cn(
                        'w-full text-left px-3 py-2.5 transition-colors',
                        selectedPaper?.meta.id === paper.id
                          ? 'bg-accent'
                          : 'hover:bg-accent/50',
                      )}
                      onClick={() => handleSelectPaper(paper.id)}
                    >
                      <p className="text-[13px] font-medium truncate text-foreground/85">
                        {paper.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {paper.authors.slice(0, 2).join(', ')}
                        {paper.authors.length > 2 && ' 等'}
                        {paper.year ? ` · ${paper.year}` : ''}
                      </p>
                      {paper.tags.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {paper.tags.map((tag) => (
                            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* 右侧内容区 */}
          <div className="flex-1 flex flex-col min-w-0 border border-border/60 rounded-lg overflow-hidden">
            {searchResults ? renderSearchResults() : renderPaperDetail()}
          </div>
        </div>
      )}

      {/* 导入对话框 */}
      <ImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        onImportComplete={handleImportComplete}
      />
    </div>
  )
}
