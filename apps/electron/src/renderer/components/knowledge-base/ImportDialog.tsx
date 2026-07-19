import React, { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileUp, Globe, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ArxivPaper } from '@profer/shared'

const ACCEPTED_EXTENSIONS = '.pdf,.doc,.docx,.docm,.dot,.dotx,.dotm,.wps,.wpt,.rtf,.pptx,.pptm,.potx,.potm,.ppsx,.ppsm,.odp,.dps,.dpt,.xlsx,.xlsm,.xltx,.xltm,.ods,.et,.ett,.md,.txt'

interface ImportDialogProps { open: boolean; onOpenChange: (open: boolean) => void; onImportComplete: () => void }

export function ImportDialog({ open, onOpenChange, onImportComplete }: ImportDialogProps) {
  const [arxivQuery, setArxivQuery] = useState('')
  const [arxivResults, setArxivResults] = useState<ArxivPaper[]>([])
  const [searching, setSearching] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const importFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    if (files.length > 10) { toast.error('一次最多导入 10 份资料'); return }
    const paths = files.map((file) => window.electronAPI.getPathForFile(file)).filter((path): path is string => Boolean(path))
    if (!paths.length) return
    setImporting(true)
    try {
      const result = await window.electronAPI.knowledge.importItems(paths)
      const failed = result.results.filter((item) => item.error)
      const success = result.results.length - failed.length
      if (success) toast.success(`已导入 ${success} 份资料`)
      if (failed.length) toast.error(`${failed.length} 份资料导入失败：${failed[0]?.error || '未知错误'}`)
      if (success) onImportComplete()
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '资料导入失败') } finally { setImporting(false) }
  }, [onImportComplete])

  const searchArxiv = async () => {
    if (!arxivQuery.trim()) return
    setSearching(true)
    try { setArxivResults(await window.electronAPI.kb.searchArxiv(arxivQuery.trim(), 10)) } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'arXiv 搜索失败') } finally { setSearching(false) }
  }

  const importArxiv = async (arxivId: string) => {
    setImporting(true)
    try { await window.electronAPI.kb.import({ source: { type: 'arxiv', arxivId } }); toast.success('研究资料导入成功'); onImportComplete() } catch (cause) { toast.error(cause instanceof Error ? cause.message : '导入失败') } finally { setImporting(false) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden"><DialogHeader><DialogTitle>导入资料</DialogTitle><DialogDescription>本地资料仅保存在此设备；arXiv 资料可使用研究资料增强能力。</DialogDescription></DialogHeader><Tabs defaultValue="local"><TabsList className="w-full"><TabsTrigger value="local" className="flex-1"><FileUp className="mr-1.5 size-4"/>本地资料</TabsTrigger><TabsTrigger value="arxiv" className="flex-1"><Globe className="mr-1.5 size-4"/>研究资料 / arXiv</TabsTrigger></TabsList><TabsContent value="local" className="mt-3"><input ref={inputRef} type="file" multiple accept={ACCEPTED_EXTENSIONS} className="hidden" onChange={(event) => { void importFiles(Array.from(event.target.files || [])); event.target.value = '' }}/><div className={cn('flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors', dragging ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:bg-accent/20')} onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void importFiles(Array.from(event.dataTransfer.files)) }}>{importing ? <><Loader2 className="size-8 animate-spin text-primary"/><p className="text-sm text-muted-foreground">正在导入并提取正文…</p></> : <><FileUp className="size-9 text-muted-foreground"/><div className="text-center"><p className="text-sm font-medium">拖拽资料到此处或点击选择</p><p className="mt-1 max-w-md text-xs text-muted-foreground">支持 PDF、Word/WPS、演示文稿、表格、Markdown、TXT；一次最多 10 份。</p></div></>}</div></TabsContent><TabsContent value="arxiv" className="mt-3"><div className="flex gap-2"><input value={arxivQuery} onChange={(event) => setArxivQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchArxiv() }} placeholder="搜索 arXiv 论文" className="h-9 min-w-0 flex-1 rounded border bg-transparent px-3 text-sm outline-none"/><button type="button" onClick={() => void searchArxiv()} disabled={searching || !arxivQuery.trim()} className="flex h-9 items-center gap-1 rounded bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40">{searching ? <Loader2 className="size-3 animate-spin"/> : <Search className="size-3"/>}搜索</button></div><ScrollArea className="mt-3 h-64">{arxivResults.map((paper) => <div key={paper.arxivId} className="flex gap-3 border-b p-3"><div className="min-w-0 flex-1"><p className="line-clamp-2 text-sm font-medium">{paper.title}</p><p className="mt-1 text-xs text-muted-foreground">{paper.authors.slice(0, 3).join(', ')} · {paper.year}</p></div><button type="button" disabled={importing} onClick={() => void importArxiv(paper.arxivId)} className="h-7 rounded bg-primary px-2 text-xs text-primary-foreground disabled:opacity-40">导入</button></div>)}{!arxivResults.length ? <div className="py-16 text-center text-sm text-muted-foreground">输入关键词搜索 arXiv 研究资料</div> : null}</ScrollArea></TabsContent></Tabs></DialogContent></Dialog>
}
