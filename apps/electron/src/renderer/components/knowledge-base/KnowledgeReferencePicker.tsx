import { Button } from '@profer/ui/primitives/button'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import * as React from 'react'
import { Check, FileText, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@profer/ui/primitives/dialog'
import type { KnowledgeItem } from '@profer/shared'
import { getItemKind } from './knowledge-base-workbench-utils'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (itemIds: string[]) => void | Promise<void>
}

const KIND_LABEL: Record<string, string> = { pdf: 'PDF', word: 'Word', wps: 'WPS', presentation: '演示文稿', spreadsheet: '表格', markdown: 'Markdown', text: '文本' }

/** 可复用于 Chat 与 Agent 的轻量资料选择器；不包含删除等管理副作用。 */
export function KnowledgeReferencePicker({ open, onOpenChange, onConfirm }: Props): React.ReactElement {
  const [items, setItems] = React.useState<KnowledgeItem[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const [error, setError] = React.useState<string | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [reload, setReload] = React.useState(0)

  React.useEffect(() => {
    if (!open) return
    let active = true
    setSelected(new Set()); setLoading(true); setError(null); setLoadFailed(false)
    void window.electronAPI.knowledge.getLibrarySnapshot()
      .then((snapshot) => { if (active) setItems(snapshot.items) })
      .catch(() => { if (active) { setItems([]); setLoadFailed(true); setError('读取资料失败，请重试') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, reload])

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else if (next.size < 10) next.add(id)
    return next
  })
  const submit = async () => {
    if (!selected.size) return
    setSaving(true); setError(null)
    try { await onConfirm([...selected]); onOpenChange(false) } catch (error) { setError(error instanceof Error ? error.message : '导入失败，请重试') } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>选择要导入的资料</DialogTitle>
          <DialogDescription>选择 1–10 份资料作为引用，提问时检索相关片段。</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end text-xs text-muted-foreground">已选择 {selected.size}/10</div>
        {error && <div role="alert" className="flex items-center justify-between gap-2 text-sm text-destructive-text">
          <span>{error}</span>
          {loadFailed && <Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>重新读取</Button>}
        </div>}
        <ScrollRegion className="max-h-72 overflow-y-auto rounded border" aria-busy={loading}>
          {loading ? <div role="status" aria-label="正在读取资料" className="flex h-32 items-center justify-center"><Loader2 className="size-4 animate-spin"/></div> : items.map((item) => (
            <button key={item.id} type="button" aria-pressed={selected.has(item.id)} disabled={saving} onClick={() => toggle(item.id)} className={cn('flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', selected.has(item.id) && 'bg-primary/5')}>
              <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded border', selected.has(item.id) && 'border-primary bg-primary text-primary-foreground')}>{selected.has(item.id) ? <Check className="size-3"/> : null}</span>
              <FileText className="size-4 text-muted-foreground"/>
              <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
              <span className="text-[11px] text-muted-foreground">{KIND_LABEL[getItemKind(item)] || getItemKind(item)}</span>
            </button>
          ))}
          {!loading && !error && !items.length && <p className="p-8 text-center text-sm text-muted-foreground">资料库中还没有可导入的资料</p>}
        </ScrollRegion>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!selected.size || saving || loading || loadFailed} onClick={() => void submit()}>{saving ? '导入中…' : `导入 ${selected.size || ''} 份资料`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
