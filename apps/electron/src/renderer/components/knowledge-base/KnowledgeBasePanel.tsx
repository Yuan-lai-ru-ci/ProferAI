import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { BookOpen, CheckSquare, FileText, Heart, Library, Loader2, Plus, RefreshCw, Search, Send, Star, Tag, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ImportDialog } from './ImportDialog'
import { KnowledgeSessionTargetPicker, type KnowledgeTarget } from './KnowledgeSessionTargetPicker'
import { chatPendingKnowledgeReferencesAtom, conversationsAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { WindowControls } from '@/components/WindowControls'
import { markdownToSafeDisplayHtml } from '@/lib/markdown-rich-text'
import { detectIsWindows } from '@/lib/platform'
import type { KnowledgeBaseWorkbenchPatch, KnowledgeItem, KnowledgeReference, PaperMeta, PaperWorkbenchRecord } from '@profer/shared'
import { EMPTY_WORKBENCH_RECORD, filterAndSortItems, formatProgress, getAllWorkbenchTags, getItemAuthors, getItemKind, getItemOrigin, getItemSummary, toDisplayItems, type DisplayLibraryItem, type LibraryItem, type LibrarySort } from './knowledge-base-workbench-utils'

type SelectedItem = { meta: KnowledgeItem | PaperMeta; text: string }
type Collection = 'all' | 'favorite' | 'untagged'

const KIND_LABEL: Record<string, string> = { pdf: 'PDF', word: 'Word', wps: 'WPS', presentation: '演示文稿', spreadsheet: '表格', markdown: 'Markdown', text: '文本' }

function IconButton({ label, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip><TooltipTrigger asChild><button type="button" aria-label={label} className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40', className)} {...props}>{children}</button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}

function kindLabel(item: LibraryItem): string { return KIND_LABEL[getItemKind(item)] || '资料' }
function formatDate(timestamp: number): string { return timestamp ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp) : '未知时间' }

export function KnowledgeBasePanel() {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [records, setRecords] = useState<Record<string, PaperWorkbenchRecord>>({})
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [collection, setCollection] = useState<Collection>('all')
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isTargetPickerOpen, setIsTargetPickerOpen] = useState(false)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPendingKnowledge = useSetAtom(chatPendingKnowledgeReferencesAtom)
  const setConversations = useSetAtom(conversationsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const openSession = useOpenSession()
  const isWindows = useMemo(() => detectIsWindows(), [])

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true)
    try {
      setError(null)
      const [knowledge, legacy, workbench] = await Promise.all([
        window.electronAPI.knowledge.getLibrarySnapshot(),
        window.electronAPI.kb.getLibrarySnapshot().catch(() => ({ papers: [] as PaperMeta[] })),
        window.electronAPI.kb.getWorkbenchState(),
      ])
      const known = new Set(knowledge.items.map((item) => item.id))
      setItems([...knowledge.items, ...legacy.papers.filter((item) => !known.has(item.id))])
      setRecords(workbench.records)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法加载资料库'
      setError(message); toast.error(message)
    } finally { setLoading(false); setRefreshing(false) }
  }, [])

  useEffect(() => { void load(); return () => { if (progressTimer.current) clearTimeout(progressTimer.current) } }, [load])
  const displayItems = useMemo(() => toDisplayItems(items, records), [items, records])
  const allTags = useMemo(() => getAllWorkbenchTags(displayItems), [displayItems])
  const visibleItems = useMemo(() => {
    const scoped = displayItems.filter((item) => collection === 'all' || (collection === 'favorite' ? item.workbench.favorite : item.workbench.tags.length === 0))
    return filterAndSortItems(scoped, { query, tag, favoritesOnly: false, sort })
  }, [collection, displayItems, query, sort, tag])
  const selectedRecord = selected ? records[selected.meta.id] || EMPTY_WORKBENCH_RECORD : EMPTY_WORKBENCH_RECORD
  const safeDisplayHtml = useMemo(() => selected ? markdownToSafeDisplayHtml(selected.text) : '', [selected])

  const updateRecord = useCallback(async (itemId: string, patch: KnowledgeBaseWorkbenchPatch) => {
    const before = records[itemId] || EMPTY_WORKBENCH_RECORD
    setRecords((current) => ({ ...current, [itemId]: { ...before, ...patch, updatedAt: Date.now() } }))
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
      const local = await window.electronAPI.knowledge.getItem(item.id)
      if (local) { setSelected({ meta: local.meta, text: local.text }); return }
      const legacy = await window.electronAPI.kb.getPaper(item.id)
      if (legacy) { setSelected({ meta: legacy.meta, text: legacy.markdown }); return }
      toast.error('资料正文暂不可读取，请检查本地缓存')
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '加载资料失败') }
  }, [])

  const toggleSelection = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else if (next.size < 10) next.add(id)
    else { toast.error('一次最多选择 10 份资料'); return current }
    return next
  })

  const deleteItems = useCallback(async (ids: string[]) => {
    if (!ids.length || !window.confirm(`确定删除 ${ids.length} 份资料吗？此操作不可恢复。`)) return
    const outcomes = await Promise.allSettled(ids.map((id) => window.electronAPI.knowledge.deleteItem(id)))
    const deleted = ids.filter((_, index) => outcomes[index]?.status === 'fulfilled')
    if (deleted.length) {
      await window.electronAPI.kb.deleteWorkbenchRecords(deleted)
      setSelectedIds((current) => new Set([...current].filter((id) => !deleted.includes(id))))
      if (selected && deleted.includes(selected.meta.id)) setSelected(null)
      await load(true)
    }
    toast[deleted.length === ids.length ? 'success' : 'error'](deleted.length === ids.length ? `已删除 ${deleted.length} 份资料` : `${ids.length - deleted.length} 份资料删除失败`)
  }, [items, load, selected])

  const importSelectedToTarget = useCallback(async (target: KnowledgeTarget) => {
    const chosen = items.filter((item) => selectedIds.has(item.id))
    if (!chosen.length) return
    const references: KnowledgeReference[] = chosen.map((item) => ({ itemId: item.id, title: item.title, kind: getItemKind(item) as KnowledgeReference['kind'], origin: getItemOrigin(item), importedAt: Date.now() }))
    if (target.kind === 'chat') {
      const conversation = target.sessionId ? undefined : await window.electronAPI.createConversation('资料对话')
      const sessionId = target.sessionId || conversation!.id
      if (conversation) setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
      setPendingKnowledge({ conversationId: sessionId, references })
      openSession('chat', sessionId, target.title || conversation?.title || '对话')
      toast.success('资料已放入 Chat 输入区')
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

  const onReaderScroll = () => {
    if (!selected || !readerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = readerRef.current
    const progress = Math.max(0, Math.min(1, scrollTop / Math.max(1, scrollHeight - clientHeight)))
    if (progressTimer.current) clearTimeout(progressTimer.current)
    progressTimer.current = setTimeout(() => { void updateRecord(selected.meta.id, { readingProgress: progress }) }, 700)
  }

  const count = (value: Collection) => value === 'all' ? items.length : displayItems.filter((item) => value === 'favorite' ? item.workbench.favorite : item.workbench.tags.length === 0).length

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
    <header className="relative z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3"><div className={cn('pointer-events-none absolute inset-0 titlebar-drag-region', isWindows && 'right-[118px]')}/><div className="flex min-w-0 flex-1 items-center gap-2"><Library className="size-4 text-muted-foreground"/><h1 className="truncate text-sm font-semibold">资料库</h1><span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">{items.length}</span></div><div className="titlebar-no-drag flex items-center gap-1"><IconButton label="刷新资料库" onClick={() => void load(true)} disabled={refreshing}>{refreshing ? <Loader2 className="size-4 animate-spin"/> : <RefreshCw className="size-4"/>}</IconButton><button type="button" onClick={() => setIsImportOpen(true)} className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"><Plus className="size-3.5"/>导入资料</button></div><WindowControls variant="inline" className="titlebar-no-drag -mr-1 ml-1"/></header>
    {error ? <div className="flex flex-1 flex-col items-center justify-center gap-3"><p className="text-sm">{error}</p><button type="button" onClick={() => void load()} className="rounded border px-3 py-1.5 text-xs">重试</button></div> : loading ? <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin"/></div> : <div className="flex min-h-0 flex-1">
      <section className="flex w-[min(38%,460px)] min-w-[320px] shrink-0 flex-col border-r border-border/60 bg-content-area/20"><div className="space-y-2 border-b border-border/60 p-3"><div className="flex h-8 items-center gap-2 rounded-md border border-border/60 bg-background px-2"><Search className="size-3.5 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料" className="min-w-0 flex-1 bg-transparent text-xs outline-none"/>{query ? <IconButton label="清除搜索" onClick={() => setQuery('')}><X className="size-3.5"/></IconButton> : null}</div><div className="flex items-center gap-1 overflow-x-auto pb-0.5">{([['all', '全部', Library], ['favorite', '收藏', Star], ['untagged', '待整理', Tag]] as const).map(([value, label, Icon]) => <button key={value} type="button" onClick={() => { setCollection(value); setTag(null) }} className={cn('flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px]', collection === value && !tag ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground')}><Icon className="size-3"/>{label}<span className="text-[10px] opacity-70">{count(value)}</span></button>)}</div>{allTags.length ? <div className="flex items-center gap-1 overflow-x-auto pb-0.5">{allTags.map((value) => <button key={value} type="button" onClick={() => { setTag(tag === value ? null : value); setCollection('all') }} className={cn('h-6 shrink-0 rounded px-1.5 text-[10px]', tag === value ? 'bg-primary text-primary-foreground' : 'bg-accent/70 text-muted-foreground hover:text-foreground')}>{value}</button>)}</div> : null}<div className="flex items-center gap-2 pt-1"><span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{visibleItems.length} 份资料</span><select aria-label="排序方式" value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)} className="h-7 rounded-md border border-border/60 bg-background px-2 text-[11px]"><option value="recent">最近导入</option><option value="title">标题 A-Z</option><option value="favorite">收藏优先</option></select><button type="button" disabled={!selectedIds.size} onClick={() => setIsTargetPickerOpen(true)} className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"><Send className="size-3"/>用于 Agent</button></div></div>
        {selectedIds.size ? <BatchToolbar selectedIds={selectedIds} records={records} onUpdate={updateRecord} onSend={() => setIsTargetPickerOpen(true)} onDelete={() => void deleteItems([...selectedIds])} onClear={() => setSelectedIds(new Set())}/> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{visibleItems.map((item) => <LibraryRow key={item.id} item={item} active={selected?.meta.id === item.id} checked={selectedIds.has(item.id)} onSelect={selectItem} onToggle={toggleSelection}/>)}{!visibleItems.length ? <div className="px-5 py-12 text-center text-xs text-muted-foreground">没有匹配的资料</div> : null}</div>
      </section>
      <main className="flex min-w-0 flex-1">{selected ? <div ref={readerRef} onScroll={onReaderScroll} className="min-w-0 flex-1 overflow-y-auto"><article className="mx-auto max-w-3xl px-7 py-7"><div className="mb-6 flex items-start gap-3 border-b border-border/60 pb-5"><FileText className="mt-1 size-5 shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1"><h2 className="text-xl font-semibold leading-7">{selected.meta.title}</h2><p className="mt-1 text-sm text-muted-foreground">{getItemAuthors(selected.meta).join(', ') || selected.meta.originalFileName || kindLabel(selected.meta)}</p></div><button type="button" onClick={() => setIsDetailOpen(true)} className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">详情</button></div>{selected.text ? <div className="prose prose-sm max-w-none overflow-x-auto text-foreground/85 [&_pre]:bg-accent/60" dangerouslySetInnerHTML={{ __html: safeDisplayHtml }}/> : <p className="text-sm text-muted-foreground">该资料暂无可阅读内容。</p>}</article></div> : <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><BookOpen className="size-10 opacity-30"/><div><p className="text-sm font-medium text-foreground">从资料列表选择一份内容</p><p className="mt-1 text-xs">阅读、整理后将资料带入 Agent 或 Chat</p></div></div>}</main>
    </div>}
    <ImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} onImportComplete={() => { setIsImportOpen(false); void load(true) }}/><KnowledgeSessionTargetPicker open={isTargetPickerOpen} itemCount={selectedIds.size} onOpenChange={setIsTargetPickerOpen} onSelect={importSelectedToTarget}/>{selected ? <DetailPanel open={isDetailOpen} onOpenChange={setIsDetailOpen} item={selected.meta} record={selectedRecord} onUpdate={(patch) => void updateRecord(selected.meta.id, patch)} onDelete={() => void deleteItems([selected.meta.id])}/> : null}
  </div>
}

function BatchToolbar({ selectedIds, records, onUpdate, onSend, onDelete, onClear }: { selectedIds: Set<string>; records: Record<string, PaperWorkbenchRecord>; onUpdate: (id: string, patch: KnowledgeBaseWorkbenchPatch) => Promise<void>; onSend: () => void; onDelete: () => void; onClear: () => void }) {
  const [tag, setTag] = useState('')
  const addTag = async () => {
    const value = tag.trim()
    if (!value) return
    await Promise.all([...selectedIds].map((id) => onUpdate(id, { tags: [...new Set([...(records[id] || EMPTY_WORKBENCH_RECORD).tags, value])] })))
    setTag('')
  }
  return <div className="flex h-10 items-center gap-1 border-b bg-primary/5 px-3"><span className="mr-auto text-[11px] text-muted-foreground">已选择 {selectedIds.size} 份</span><input aria-label="批量添加标签" value={tag} onChange={(event) => setTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addTag() }} placeholder="添加标签" className="h-6 w-28 rounded border bg-background px-2 text-[10px] outline-none"/><IconButton label="发送到会话" onClick={onSend}><Send className="size-3.5"/></IconButton><IconButton label="删除所选" className="hover:text-destructive" onClick={onDelete}><Trash2 className="size-3.5"/></IconButton><IconButton label="取消选择" onClick={onClear}><X className="size-3.5"/></IconButton></div>
}

function LibraryRow({ item, active, checked, onSelect, onToggle }: { item: DisplayLibraryItem; active: boolean; checked: boolean; onSelect: (item: LibraryItem) => void; onToggle: (id: string) => void }) {
  const summary = getItemSummary(item)
  return <div
    className={cn('group flex cursor-pointer gap-2 border-b border-border/40 px-3 py-3 hover:bg-accent/60', active && 'bg-accent')}
    onClick={() => void onSelect(item)}
  >
    <button type="button" aria-label={`选择 ${item.title}`} onClick={(event) => { event.stopPropagation(); onToggle(item.id) }} className="mt-0.5 text-muted-foreground">
      {checked ? <CheckSquare className="size-3.5 text-primary"/> : <span className="block size-3.5 rounded-sm border border-border/80"/>}
    </button>
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-1"><p className="line-clamp-2 flex-1 text-xs font-medium leading-4">{item.title}</p>{item.workbench.favorite ? <Heart className="mt-0.5 size-3 shrink-0 fill-rose-500 text-rose-500"/> : null}</div>
      <p className="mt-1 truncate text-[10px] text-muted-foreground">{getItemAuthors(item).join(', ') || kindLabel(item)}</p>
      {summary ? <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground/80">{summary}</p> : null}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground"><span>{kindLabel(item)}</span><span>{formatDate(item.importedAt)}</span>{item.workbench.tags.length ? <span className="truncate text-primary">{item.workbench.tags.slice(0, 2).join(' · ')}</span> : null}</div>
    </div>
    <div className="mt-1 w-10 shrink-0"><div className="h-1 overflow-hidden rounded bg-border"><div className="h-full bg-primary" style={{ width: formatProgress(item.workbench.readingProgress) }}/></div></div>
  </div>
}

function DetailPanel({ open, onOpenChange, item, record, onUpdate, onDelete }: { open: boolean; onOpenChange: (open: boolean) => void; item: KnowledgeItem | PaperMeta; record: PaperWorkbenchRecord; onUpdate: (patch: KnowledgeBaseWorkbenchPatch) => void; onDelete: () => void }) {
  const [tagInput, setTagInput] = useState('')
  const [note, setNote] = useState(record.note)
  useEffect(() => { setNote(record.note) }, [item.id, record.note])
  const addTag = () => { const value = tagInput.trim(); if (!value || record.tags.includes(value)) return; onUpdate({ tags: [...record.tags, value] }); setTagInput('') }
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent hideClose side="right" className="flex w-[360px] flex-col gap-0 p-0 sm:max-w-[360px]"><div className="flex items-center border-b border-border/60 px-4 py-3"><SheetTitle className="min-w-0 flex-1 truncate text-sm">资料详情</SheetTitle><IconButton label={record.favorite ? '取消收藏' : '收藏资料'} onClick={() => onUpdate({ favorite: !record.favorite })}><Heart className={cn('size-4', record.favorite && 'fill-rose-500 text-rose-500')}/></IconButton><IconButton label="删除资料" className="hover:text-destructive" onClick={onDelete}><Trash2 className="size-4"/></IconButton><IconButton label="关闭详情" onClick={() => onOpenChange(false)}><X className="size-4"/></IconButton></div><div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4"><section><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">信息</p><dl className="space-y-2 text-[11px]"><div className="flex justify-between gap-2"><dt className="text-muted-foreground">类型</dt><dd>{kindLabel(item)}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">来源</dt><dd>{getItemOrigin(item) === 'arxiv' ? '研究资料' : '本地资料'}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">阅读进度</dt><dd>{formatProgress(record.readingProgress)}</dd></div></dl></section><section><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">标签</p><div className="mb-2 flex flex-wrap gap-1">{record.tags.map((value) => <button key={value} type="button" onClick={() => onUpdate({ tags: record.tags.filter((tag) => tag !== value) })} className="group flex items-center gap-1 rounded bg-primary/10 px-1.5 py-1 text-[10px] text-primary">{value}<X className="size-2.5 opacity-60 group-hover:opacity-100"/></button>)}</div><div className="flex gap-1"><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTag() }} placeholder="添加标签" className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-[11px] outline-none"/><button type="button" onClick={addTag} className="h-7 rounded border px-2 text-[11px] hover:bg-accent">添加</button></div></section><section><p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">笔记</p><textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => { if (note !== record.note) onUpdate({ note }) }} placeholder="记录这份资料的要点..." className="min-h-32 w-full resize-y rounded border border-border/60 bg-background p-2 text-xs leading-5 outline-none focus:border-primary"/></section></div></SheetContent></Sheet>
}
