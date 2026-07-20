import * as React from 'react'
import { File, Folder, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { TeamTrashEntry } from '@profer/shared'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

function resourceName(path: string) { return path.split('/').filter(Boolean).at(-1) || path }
function formatRemaining(expiresAt: number) {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return '等待自动清理'
  const hours = Math.ceil(ms / 3_600_000)
  return hours >= 24 ? `剩余 ${Math.ceil(hours / 24)} 天` : `剩余 ${hours} 小时`
}
function formatTime(time: number) { return new Date(time).toLocaleString() }

export function TeamFileTrashSheet({ workspaceId, open, onOpenChange, onRestored }: { workspaceId: string; open: boolean; onOpenChange: (open: boolean) => void; onRestored: (path: string) => void }) {
  const [entries, setEntries] = React.useState<TeamTrashEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = React.useState<TeamTrashEntry | null>(null)

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    const result = await window.electronAPI.teamFile.listTrash(workspaceId)
    setLoading(false)
    if (!result?.ok) { toast.error(result?.error || '读取回收站失败'); return }
    setEntries(result.data || [])
  }, [workspaceId])

  React.useEffect(() => { if (open) void load() }, [open, load])

  const restore = async (entry: TeamTrashEntry) => {
    setBusyId(entry.id)
    const result = await window.electronAPI.teamFile.restoreTrash(workspaceId, entry.id)
    setBusyId(null)
    if (!result?.ok || !result.data) { toast.error(result?.error || '恢复失败'); return }
    setEntries((items) => items.filter((item) => item.id !== entry.id))
    onRestored(result.data.restoredPath)
    toast.success(`已恢复到：${result.data.restoredPath}`)
  }

  const purge = async () => {
    if (!purgeTarget) return
    const entry = purgeTarget
    setBusyId(entry.id)
    const result = await window.electronAPI.teamFile.purgeTrash(workspaceId, entry.id)
    setBusyId(null)
    setPurgeTarget(null)
    if (!result?.ok) { toast.error(result?.error || '永久删除失败'); return }
    setEntries((items) => items.filter((item) => item.id !== entry.id))
    toast.success('已永久删除')
  }

  return <><Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right" className="w-full p-0 sm:max-w-md"><div className="flex h-full flex-col"><SheetHeader className="border-b px-5 py-4"><SheetTitle>回收站</SheetTitle><p className="text-xs text-muted-foreground">资料删除后保留 7 天，到期自动永久删除。</p></SheetHeader>{loading ? <div className="flex flex-1 items-center justify-center"><Loader2 className="animate-spin" /></div> : entries.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground"><Trash2 size={36} strokeWidth={1.5} /><p className="text-sm">回收站为空</p><p className="text-xs">移除的团队资料会在这里保留 7 天。</p></div> : <ScrollArea className="flex-1"><div className="space-y-2 p-4">{entries.map((entry) => { const busy = busyId === entry.id; const isFolder = !resourceName(entry.originalPath).includes('.'); return <div key={entry.id} className="rounded-lg border bg-card p-3 shadow-sm"><div className="flex gap-3"><div className="mt-0.5 text-muted-foreground">{isFolder ? <Folder size={17} /> : <File size={17} />}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{resourceName(entry.originalPath)}</p><p className="mt-0.5 truncate text-xs text-muted-foreground" title={entry.originalPath}>{entry.originalPath}</p><div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground"><p>删除于 {formatTime(entry.deletedAt)}</p><p>{entry.deletedBy ? `删除人：${entry.deletedBy} · ` : ''}{formatRemaining(entry.expiresAt)}</p></div></div></div><div className="mt-3 flex justify-end gap-2"><button disabled={busy} onClick={() => void restore(entry)} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}恢复</button><button disabled={busy} onClick={() => setPurgeTarget(entry)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 size={13} />永久删除</button></div></div> })}</div></ScrollArea>}</div></SheetContent></Sheet><AlertDialog open={!!purgeTarget} onOpenChange={(next) => { if (!next && !busyId) setPurgeTarget(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>永久删除资料？</AlertDialogTitle><AlertDialogDescription>“{purgeTarget ? resourceName(purgeTarget.originalPath) : ''}”将从回收站永久删除，此操作不可撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={!!busyId}>取消</AlertDialogCancel><AlertDialogAction disabled={!!busyId} onClick={(event) => { event.preventDefault(); void purge() }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{busyId ? '删除中…' : '永久删除'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>
}
