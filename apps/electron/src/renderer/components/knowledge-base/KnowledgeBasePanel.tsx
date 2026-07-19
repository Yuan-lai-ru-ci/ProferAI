import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { BookOpen, CheckSquare, CircleX, FileText, Heart, Library, Loader2, Plus, RefreshCw, Search, Star, Trash2, X, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ImportDialog } from './ImportDialog'
import { KnowledgeSessionTargetPicker, type KnowledgeTarget } from './KnowledgeSessionTargetPicker'
import { chatPendingKnowledgeReferencesAtom, conversationsAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { WindowControls } from '@/components/WindowControls'
import { markdownToHtml } from '@/lib/markdown-rich-text'
import { detectIsWindows } from '@/lib/platform'
import type { KnowledgeItem, PaperMeta, PaperWorkbenchRecord, KnowledgeBaseWorkbenchPatch, KnowledgeReference } from '@profer/shared'
import {
  EMPTY_WORKBENCH_RECORD,
  filterAndSortItems,
  formatProgress,
  getAllWorkbenchTags,
  getItemAuthors,
  getItemKind,
  getItemOrigin,
  getItemSummary,
  toDisplayItems,
  type LibraryItem,
  type LibrarySort,
} from './knowledge-base-workbench-utils'

type SelectedItem = { meta: LibraryItem; text: string; legacy: boolean }

function IconButton({ label, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip><TooltipTrigger asChild><button type="button" aria-label={label} className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40', className)} {...props}>{children}</button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}

function kindLabel(kind: string): string {
  return ({ pdf: 'PDF', word: 'Word', wps: 'WPS', presentation: '演示文稿', spreadsheet: '表格', markdown: 'Markdown', text: '文本' } as Record<string, string>)[kind] || '资料'
}

export function KnowledgeBasePanel() {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [records, setRecords] = useState<Record<string, PaperWorkbenchRecord>>({})
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isTargetPickerOpen, setIsTargetPickerOpen] = useState(false)
  const setPendingKnowledge = useSetAtom(chatPendingKnowledgeReferencesAtom)
  const setConversations = useSetAtom(conversationsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const openSession = useOpenSession()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isWindows = useMemo(() => detectIsWindows(), [])

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true)
    try {
      setError(null)
      const [knowledge, paperSnapshot, workbench] = await Promise.all([
        window.electronAPI.knowledge.getLibrarySnapshot(),
        window.electronAPI.kb.getLibrarySnapshot().catch(() => ({ papers: [] as PaperMeta[] })),
        window.electronAPI.kb.getWorkbenchState(),
      ])
      // 通用资料优先；旧论文仅在尚未迁移时继续可见。
      const known = new Set(knowledge.items.map((item) => item.id))
      setItems([...knowledge.items, ...paperSnapshot.papers.filter((paper) => !known.has(paper.id))])
      setRecords(workbench.records)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法加载个人资料库'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load(); return () => { if (progressTimer.current) clearTimeout(progressTimer.current) } }, [load])

  const displayItems = useMemo(() => toDisplayItems(items, records), [items, records])
  const visibleItems = useMemo(() => filterAndSortItems(displayItems, { query, tag, favoritesOnly, sort }), [displayItems, query, tag, favoritesOnly, sort])
  const allTags = useMemo(() => getAllWorkbenchTags(displayItems), [displayItems])
  const selectedRecord = selected ? records[selected.meta.id] || EMPTY_WORKBENCH_RECORD : EMPTY_WORKBENCH_RECORD

  const updateRecord = useCallback(async (itemId: string, patch: KnowledgeBaseWorkbenchPatch) => {
    const before = records[itemId] || EMPTY_WORKBENCH_RECORD
    const optimistic = { ...before, ...patch, updatedAt: Date.now() }
    setRecords((current) => ({ ...current, [itemId]: optimistic }))
    try {
      const persisted = await window.electronAPI.kb.updateWorkbenchRecord(itemId, patch)
      setRecords((current) => ({ ...current, [itemId]: persisted }))
    } catch (cause) {
      setRecords((current) => ({ ...current, [itemId]: before }))
      toast.error(cause instanceof Error ? cause.message : '保存资料状态失败')
    }
  }, [records])

  const selectItem = useCallback(async (item: LibraryItem) => {
    try {
      if ('kind' in item && item.kind) {
        const loaded = await window.electronAPI.knowledge.getItem(item.id)
        if (loaded) {
          setSelected({ meta: loaded.meta, text: loaded.text, legacy: false })
          return
        }
        // 历史 arXiv 项投影到通用资料列表后也会带 kind；它们的正文仍由
        // 既有 Paperpipe 路径读取，不能因此被误报为“资料不存在”。
        if (item.origin === 'arxiv') {
          const legacy = await window.electronAPI.kb.getPaper(item.id)
          if (legacy) {
            setSelected({ meta: legacy.meta, text: legacy.markdown, legacy: true })
            return
          }
        }
        toast.error('资料正文暂不可读取，请检查本地缓存或 Paperpipe 连接')
      } else {
        const loaded = await window.electronAPI.kb.getPaper(item.id)
        if (!loaded) { toast.error('历史研究资料正文暂不可读取，请检查 Paperpipe 连接'); return }
        setSelected({ meta: loaded.meta, text: loaded.markdown, legacy: true })
      }
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '加载资料失败') }
  }, [])

  const toggleSelection = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else {
      if (next.size >= 10) { toast.error('一次最多选择 10 份资料'); return current }
      next.add(id)
    }
    return next
  })

  const importSelectedToTarget = useCallback(async (target: KnowledgeTarget) => {
    const selectedItems = items.filter((item) => selectedIds.has(item.id))
    if (!selectedItems.length) return
    const references: KnowledgeReference[] = selectedItems.map((item) => ({ itemId: item.id, title: item.title, kind: getItemKind(item) as KnowledgeReference['kind'], origin: getItemOrigin(item), importedAt: Date.now() }))
    if (target.kind === 'chat') {
      const conversation = target.sessionId ? undefined : await window.electronAPI.createConversation('资料对话')
      const sessionId = target.sessionId || conversation!.id
      if (conversation) setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
      setPendingKnowledge({ conversationId: sessionId, references })
      openSession('chat', sessionId, target.title || conversation?.title || '对话')
      toast.success('资料已放入 Chat 输入区，提问后会随当前问题发送')
    } else {
      const session = target.sessionId ? undefined : await window.electronAPI.createAgentSession('资料 Agent')
      const sessionId = target.sessionId || session!.id
      const updated = await window.electronAPI.addAgentKnowledgeReferences(sessionId, references.map((reference) => reference.itemId))
      if (session) setAgentSessions((current) => [{ ...session, knowledgeReferences: updated }, ...current.filter((item) => item.id !== session.id)])
      openSession('agent', sessionId, target.title || session?.title || 'Agent')
      toast.success(`已向 Agent 授权 ${updated.length} 份资料`)
    }
    setSelectedIds(new Set())
  }, [items, openSession, selectedIds, setAgentSessions, setConversations, setPendingKnowledge])

  const deleteItems = useCallback(async (ids: string[]) => {
    if (!ids.length || !window.confirm(`确定删除 ${ids.length} 份资料吗？此操作不可恢复。历史对话中的引用会保留，但无法再读取正文。`)) return
    const legacyIds = new Set(items.filter((item) => !('kind' in item && item.kind)).map((item) => item.id))
    const outcomes = await Promise.allSettled(ids.map((id) => legacyIds.has(id) ? window.electronAPI.kb.deletePaper(id) : window.electronAPI.knowledge.deleteItem(id)))
    const deleted = ids.filter((_, index) => outcomes[index]?.status === 'fulfilled')
    if (deleted.length) {
      await window.electronAPI.kb.deleteWorkbenchRecords(deleted)
      setSelectedIds((current) => new Set([...current].filter((id) => !deleted.includes(id))))
      if (selected && deleted.includes(selected.meta.id)) setSelected(null)
      await load(true)
    }
    if (deleted.length !== ids.length) toast.error(`${ids.length - deleted.length} 份资料删除失败`)
    else toast.success(`已删除 ${deleted.length} 份资料`)
  }, [items, load, selected])

  const onReaderScroll = () => {
    if (!selected || !readerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = readerRef.current
    const progress = Math.max(0, Math.min(1, scrollTop / Math.max(1, scrollHeight - clientHeight)))
    if (progressTimer.current) clearTimeout(progressTimer.current)
    progressTimer.current = setTimeout(() => { void updateRecord(selected.meta.id, { readingProgress: progress }) }, 700)
  }

  const renderReader = () => {
    if (!selected) return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><BookOpen className="size-10 opacity-30"/><div><p className="text-sm font-medium text-foreground">选择一份资料开始查看</p><p className="mt-1 text-xs">资料库只负责管理；请在 Chat 或 Agent 中导入资料后使用。</p></div></div>
    const { meta, text } = selected
    const isResearch = getItemOrigin(meta) === 'arxiv'
    const research = 'research' in meta
      ? meta.research
      : { arxivId: (meta as PaperMeta).arxivId, doi: (meta as PaperMeta).doi, year: (meta as PaperMeta).year }
    return <div ref={readerRef} onScroll={onReaderScroll} className="min-h-0 flex-1 overflow-y-auto"><article className="mx-auto max-w-3xl px-6 py-7"><div className="mb-6 border-b border-border/60 pb-5"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h2 className="text-xl font-semibold leading-7">{meta.title}</h2><p className="mt-2 text-sm text-muted-foreground">{getItemAuthors(meta).join(', ') || meta.originalFileName || kindLabel(getItemKind(meta))}</p><div className="mt-3 flex flex-wrap gap-1.5"><span className="rounded bg-accent px-2 py-1 text-xs text-muted-foreground">{kindLabel(getItemKind(meta))}</span><span className="rounded bg-accent px-2 py-1 text-xs text-muted-foreground">{isResearch ? '研究资料' : '本地资料'}</span>{isResearch && research?.arxivId ? <button type="button" onClick={() => void window.electronAPI.openExternal(`https://arxiv.org/abs/${research.arxivId}`)} className="rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent">arXiv:{research.arxivId}</button> : null}</div></div><div className="flex"><IconButton label={selectedRecord.favorite ? '取消收藏' : '收藏资料'} onClick={() => void updateRecord(meta.id, { favorite: !selectedRecord.favorite })}><Heart className={cn('size-4', selectedRecord.favorite && 'fill-rose-500 text-rose-500')}/></IconButton><IconButton label="删除资料" className="hover:text-destructive" onClick={() => void deleteItems([meta.id])}><Trash2 className="size-4"/></IconButton></div></div><div className="mt-4 h-1.5 overflow-hidden rounded bg-accent" aria-label={`阅读进度 ${formatProgress(selectedRecord.readingProgress)}`}><div className="h-full bg-primary transition-[width]" style={{ width: formatProgress(selectedRecord.readingProgress) }}/></div><p className="mt-1 text-right text-[10px] text-muted-foreground">阅读进度 {formatProgress(selectedRecord.readingProgress)}</p></div>{text ? <div className="prose prose-sm max-w-none overflow-x-auto text-foreground/85 [&_pre]:bg-accent/60" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }}/> : <div className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">该资料暂无可阅读内容。</div>}</article></div>
  }

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background"><header className="relative z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-3"><div className={cn('pointer-events-none absolute inset-0 titlebar-drag-region', isWindows && 'right-[118px]')}/><div className="flex min-w-0 flex-1 items-center gap-2"><Library className="size-4 text-muted-foreground"/><h1 className="truncate text-sm font-semibold">个人资料库</h1>{!loading ? <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">{items.length}</span> : null}</div><div className="titlebar-no-drag flex items-center gap-1"><IconButton label="刷新资料库" onClick={() => void load(true)} disabled={refreshing}>{refreshing ? <Loader2 className="size-4 animate-spin"/> : <RefreshCw className="size-4"/>}</IconButton><button type="button" onClick={() => setIsImportOpen(true)} className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"><Plus className="size-3.5"/>导入资料</button></div><WindowControls variant="inline" className="titlebar-no-drag -mr-1 ml-1"/></header>{error ? <div className="flex flex-1 flex-col items-center justify-center gap-3"><CircleX className="size-8 text-destructive/70"/><p className="text-sm">{error}</p><button type="button" onClick={() => void load()} className="rounded border px-3 py-1.5 text-xs">重试</button></div> : loading ? <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin"/></div> : <div className="flex min-h-0 flex-1"><aside className="flex w-[300px] shrink-0 flex-col border-r border-border/60 bg-content-area/30"><div className="space-y-2 border-b border-border/60 p-3"><div className="flex h-8 items-center gap-2 rounded-md border border-border/60 bg-background px-2"><Search className="size-3.5 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选资料、作者、标签" className="min-w-0 flex-1 bg-transparent text-xs outline-none"/>{query ? <button type="button" onClick={() => setQuery('')}><X className="size-3.5"/></button> : null}</div><div className="flex gap-1"><button type="button" onClick={() => setFavoritesOnly((value) => !value)} className={cn('flex h-7 items-center gap-1 rounded border px-2 text-[11px]', favoritesOnly ? 'bg-rose-500/10 text-rose-600' : 'text-muted-foreground')}><Star className="size-3"/>收藏</button><select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)} className="h-7 flex-1 rounded border bg-background px-2 text-[11px]"><option value="recent">最近导入</option><option value="title">标题 A-Z</option><option value="favorite">收藏优先</option></select></div>{allTags.length ? <div className="flex flex-wrap gap-1">{allTags.slice(0, 8).map((value) => <button key={value} type="button" onClick={() => setTag(tag === value ? null : value)} className={cn('rounded px-1.5 py-1 text-[10px]', tag === value ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground')}>{value}</button>)}</div> : null}</div>{selectedIds.size ? <div className="flex items-center gap-1 border-b bg-primary/5 px-2 py-1.5"><span className="mr-auto text-[11px] text-muted-foreground">已选 {selectedIds.size}</span><IconButton label="导入到会话" onClick={() => setIsTargetPickerOpen(true)}><Send className="size-3.5"/></IconButton><IconButton label="删除所选" className="hover:text-destructive" onClick={() => void deleteItems([...selectedIds])}><Trash2 className="size-3.5"/></IconButton><IconButton label="取消选择" onClick={() => setSelectedIds(new Set())}><X className="size-3.5"/></IconButton></div> : null}<div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground"><span>{visibleItems.length} / {items.length} 份</span><span>管理资料，在对话中使用</span></div><ScrollArea className="min-h-0 flex-1"><div className="pb-2">{visibleItems.map((item) => <div key={item.id} className={cn('group flex cursor-pointer gap-2 border-l-2 px-2 py-2.5 hover:bg-accent/60', selected?.meta.id === item.id ? 'border-primary bg-accent' : 'border-transparent')} onClick={() => void selectItem(item)}><button type="button" aria-label={`选择 ${item.title}`} onClick={(event) => { event.stopPropagation(); toggleSelection(item.id) }} className="mt-0.5 shrink-0">{selectedIds.has(item.id) ? <CheckSquare className="size-3.5 text-primary"/> : <span className="block size-3.5 rounded-sm border border-border/80"/>}</button><div className="min-w-0 flex-1"><div className="flex gap-1"><p className="line-clamp-2 flex-1 text-xs font-medium leading-4">{item.title}</p>{item.workbench.favorite ? <Heart className="size-3 fill-rose-500 text-rose-500"/> : null}</div><p className="mt-1 truncate text-[10px] text-muted-foreground">{kindLabel(getItemKind(item))} · {getItemOrigin(item) === 'arxiv' ? '研究资料' : '本地资料'}</p>{item.workbench.tags.length ? <div className="mt-1 flex gap-1">{item.workbench.tags.slice(0, 2).map((value) => <span key={value} className="truncate rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">{value}</span>)}</div> : null}<div className="mt-2 h-px overflow-hidden rounded bg-border" aria-label={`阅读进度 ${formatProgress(item.workbench.readingProgress)}`}><div className="h-full bg-primary" style={{ width: formatProgress(item.workbench.readingProgress) }}/></div></div></div>)}{!visibleItems.length ? <div className="px-4 py-10 text-center text-xs text-muted-foreground">没有匹配的资料</div> : null}</div></ScrollArea></aside><main className="flex min-w-0 flex-1 flex-col">{items.length ? renderReader() : <div className="flex flex-1 flex-col items-center justify-center gap-3"><Library className="size-10 text-muted-foreground/40"/><div className="text-center"><p className="text-sm font-medium">个人资料库为空</p><p className="mt-1 text-xs text-muted-foreground">导入 PDF、Word、演示文稿、表格、Markdown 或文本资料。</p></div><button type="button" onClick={() => setIsImportOpen(true)} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground">导入第一份资料</button></div>}</main></div>}<ImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} onImportComplete={() => { setIsImportOpen(false); void load(true) }}/><KnowledgeSessionTargetPicker open={isTargetPickerOpen} itemCount={selectedIds.size} onOpenChange={setIsTargetPickerOpen} onSelect={importSelectedToTarget}/></div>
}
