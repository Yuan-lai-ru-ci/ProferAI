import * as React from 'react'
import { Check, MoreHorizontal, Pencil, Plus, Tags, Trash2, X } from 'lucide-react'
import type { PlanningTag } from '@profer/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

interface PlanningTagManagerProps {
  tags: PlanningTag[]
  getUsageCount: (tagId: string) => number
  onCreate: (name: string) => Promise<PlanningTag | undefined>
  onRename: (tag: PlanningTag, name: string) => Promise<PlanningTag | undefined>
  onDelete: (tag: PlanningTag) => Promise<boolean>
  onCreated?: (tag: PlanningTag) => void
}

/** 日程标签的就地管理器；删除标签只解除关联，不删除 Todo 或日程。 */
export function PlanningTagManager({ tags, getUsageCount, onCreate, onRename, onDelete, onCreated }: PlanningTagManagerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [renaming, setRenaming] = React.useState<PlanningTag | null>(null)
  const [renameName, setRenameName] = React.useState('')
  const [pendingDeletion, setPendingDeletion] = React.useState<PlanningTag | null>(null)
  const [busy, setBusy] = React.useState(false)

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      const tag = await onCreate(name)
      if (tag) { setNewName(''); onCreated?.(tag) }
    } finally { setBusy(false) }
  }
  const rename = async (): Promise<void> => {
    if (!renaming || !renameName.trim() || busy) return
    setBusy(true)
    try {
      const tag = await onRename(renaming, renameName.trim())
      if (tag) { setRenaming(null); setRenameName('') }
    } finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!pendingDeletion || busy) return
    setBusy(true)
    try { if (await onDelete(pendingDeletion)) setPendingDeletion(null) } finally { setBusy(false) }
  }

  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"><Tags className="mr-1 h-3.5 w-3.5" />管理标签</Button></PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-none border-border/60 p-3 shadow-xl">
        <div className="flex items-center justify-between border-b border-border/60 pb-3"><div><p className="text-sm font-semibold">标签</p><p className="mt-0.5 text-xs text-muted-foreground">创建、重命名或删除标签</p></div></div>
        <div className="mt-3 flex gap-1.5"><Input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void create() } }} placeholder="新标签名称" className="h-9" /><Button type="button" size="icon" className="size-9" disabled={!newName.trim() || busy} onClick={() => void create()} aria-label="新建标签"><Plus size={16} /></Button></div>
        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto scrollbar-thin">{tags.length ? tags.map((tag) => {
          const editing = renaming?.id === tag.id
          return <div key={tag.id} className="flex min-h-10 items-center gap-1 rounded-md px-1.5 hover:bg-muted/55">{editing ? <><Input autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void rename() } else if (event.key === 'Escape') setRenaming(null) }} className="h-8 min-w-0 flex-1" /><Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => void rename()} disabled={!renameName.trim() || busy}><Check size={15} /></Button><Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setRenaming(null)}><X size={15} /></Button></> : <><span className="min-w-0 flex-1 truncate text-sm">#{tag.name}</span><span className="text-xs tabular-nums text-muted-foreground">{getUsageCount(tag.id)}</span><DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`管理标签 ${tag.name}`}><MoreHorizontal size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setRenaming(tag); setRenameName(tag.name) }}><Pencil />重命名</DropdownMenuItem><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { setPendingDeletion(tag); setOpen(false) }}><Trash2 />删除</DropdownMenuItem></DropdownMenuContent></DropdownMenu></>}</div>
        }) : <p className="px-2 py-6 text-center text-sm text-muted-foreground">还没有标签</p>}</div>
      </PopoverContent>
    </Popover>
    <AlertDialog open={!!pendingDeletion} onOpenChange={(next) => { if (!next && !busy) setPendingDeletion(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认删除标签</AlertDialogTitle><AlertDialogDescription>删除「{pendingDeletion?.name}」后，会解除 {pendingDeletion ? getUsageCount(pendingDeletion.id) : 0} 个 Todo 或日程的关联；计划项本身不会删除。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void remove() }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{busy ? '删除中…' : '删除'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
