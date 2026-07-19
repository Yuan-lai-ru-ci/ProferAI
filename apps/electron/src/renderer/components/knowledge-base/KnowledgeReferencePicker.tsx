import * as React from 'react'
import { Check, FileText, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { KnowledgeItem, PaperMeta } from '@profer/shared'
import { getItemKind, toDisplayItems, type LibraryItem } from './knowledge-base-workbench-utils'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (itemIds: string[]) => void | Promise<void>
}

const KIND_LABEL: Record<string, string> = { pdf: 'PDF', word: 'Word', wps: 'WPS', presentation: '演示文稿', spreadsheet: '表格', markdown: 'Markdown', text: '文本' }

/** 可复用于 Chat 与 Agent 的轻量资料选择器；不包含删除等管理副作用。 */
export function KnowledgeReferencePicker({ open, onOpenChange, onConfirm }: Props): React.ReactElement {
  const [items, setItems] = React.useState<LibraryItem[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setSelected(new Set()); setLoading(true)
    Promise.all([
      window.electronAPI.knowledge.getLibrarySnapshot(),
      window.electronAPI.kb.getLibrarySnapshot().catch(() => ({ papers: [] as PaperMeta[] })),
      window.electronAPI.kb.getWorkbenchState(),
    ]).then(([knowledge, legacy, workbench]) => {
      const known = new Set(knowledge.items.map((item) => item.id))
      setItems(toDisplayItems([...knowledge.items, ...legacy.papers.filter((paper) => !known.has(paper.id))], workbench.records))
    }).catch(() => setItems([])).finally(() => setLoading(false))
  }, [open])

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else if (next.size < 10) next.add(id)
    return next
  })
  const submit = async () => {
    if (!selected.size) return
    setSaving(true)
    try { await onConfirm([...selected]); onOpenChange(false) } finally { setSaving(false) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>选择要导入的资料</DialogTitle><DialogDescription>勾选 1–10 份资料。导入的是轻量引用；Chat 会在提问时从所选资料中检索有限相关片段。</DialogDescription></DialogHeader><div className="flex justify-end text-xs text-muted-foreground">已选择 {selected.size}/10</div><div className="max-h-72 overflow-y-auto rounded border">{loading ? <div className="flex h-32 items-center justify-center"><Loader2 className="size-4 animate-spin"/></div> : items.map((item) => <button key={item.id} type="button" onClick={() => toggle(item.id)} className={cn('flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent', selected.has(item.id) && 'bg-primary/5')}><span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', selected.has(item.id) && 'border-primary bg-primary text-primary-foreground')}>{selected.has(item.id) ? <Check className="size-3"/> : null}</span><FileText className="size-4 text-muted-foreground"/><span className="min-w-0 flex-1 truncate text-sm">{item.title}</span><span className="text-[11px] text-muted-foreground">{KIND_LABEL[getItemKind(item)] || getItemKind(item)}</span></button>)}{!loading && !items.length ? <p className="p-8 text-center text-sm text-muted-foreground">资料库中还没有可导入的资料</p> : null}</div><DialogFooter><button type="button" onClick={() => onOpenChange(false)} className="rounded px-3 py-2 text-sm hover:bg-accent">取消</button><button type="button" disabled={!selected.size || saving} onClick={() => void submit()} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40">{saving ? '导入中…' : `导入 ${selected.size || ''} 份资料`}</button></DialogFooter></DialogContent></Dialog>
}
