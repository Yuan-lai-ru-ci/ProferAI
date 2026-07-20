import * as React from 'react'
import { Heart, Loader2, Save, Tag } from 'lucide-react'
import { toast } from 'sonner'
import type { FileEntry } from '@profer/shared'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

type TagItem = { id: string; name: string; color: string }
type StatusItem = { id: string; name: string; color: string; position?: number }
type Member = { userId: string; displayName: string }
type Detail = { fileId: string; path: string; description: string; statusId: string | null; primaryOwnerId: string | null; version: number; tags: TagItem[]; preference: { isFavorite: boolean; lastAccessedAt: number | null } }
type Activity = { id: string; actorId: string | null; type: string; createdAt: number }

export function TeamFileMetadataSheet({ workspaceId, entry, open, onOpenChange }: { workspaceId: string; entry: FileEntry | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [detail, setDetail] = React.useState<Detail | null>(null)
  const [draft, setDraft] = React.useState<Detail | null>(null)
  const [tags, setTags] = React.useState<TagItem[]>([])
  const [statuses, setStatuses] = React.useState<StatusItem[]>([])
  const [members, setMembers] = React.useState<Member[]>([])
  const [activities, setActivities] = React.useState<Activity[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const fileId = entry?.fileId

  const load = React.useCallback(async (keepDraft = false) => {
    if (!fileId) return
    setLoading(true)
    try {
      const [next, nextTags, nextStatuses, nextMembers, nextActivities] = await Promise.all([
        window.electronAPI.teamFile.getMetadata(workspaceId, fileId),
        window.electronAPI.teamFile.getTags(workspaceId),
        window.electronAPI.teamFile.getStatuses(workspaceId),
        window.electronAPI.team.getMembers(workspaceId),
        window.electronAPI.teamFile.getActivities(workspaceId, fileId),
      ])
      if (!next?.ok || !next.data) throw new Error(next?.error || '无法读取资料详情')
      setDetail(next.data as Detail)
      if (!keepDraft) setDraft(next.data as Detail)
      setTags((nextTags?.data || []) as TagItem[])
      setStatuses((nextStatuses?.data || []) as StatusItem[])
      setMembers((nextMembers || []) as Member[])
      setActivities((((nextActivities?.data as { activities?: Activity[] } | undefined)?.activities || []) as Activity[]))
      void window.electronAPI.teamFile.setPreference(workspaceId, fileId, { accessedAt: Date.now() })
    } catch (error) { toast.error(error instanceof Error ? error.message : '读取资料详情失败') } finally { setLoading(false) }
  }, [fileId, workspaceId])

  React.useEffect(() => { if (open) { setConflict(false); void load() } }, [open, load])
  const toggleTag = (id: string) => setDraft((current) => current ? { ...current, tags: current.tags.some((tag) => tag.id === id) ? current.tags.filter((tag) => tag.id !== id) : [...current.tags, tags.find((tag) => tag.id === id)!] } : current)
  const save = async () => {
    if (!fileId || !detail || !draft) return
    setSaving(true)
    const result = await window.electronAPI.teamFile.patchMetadata(workspaceId, fileId, { description: draft.description, statusId: draft.statusId, primaryOwnerId: draft.primaryOwnerId, tagIds: draft.tags.map((tag) => tag.id), expectedVersion: detail.version })
    setSaving(false)
    if (!result?.ok) { if (result?.status === 409) { setConflict(true); void load(true) } else toast.error(result?.error || '保存失败'); return }
    setDetail(result.data as Detail); setDraft(result.data as Detail); setConflict(false); toast.success('资料已保存')
  }
  const toggleFavorite = async () => { if (!detail || !fileId) return; const next = !detail.preference.isFavorite; setDetail({ ...detail, preference: { ...detail.preference, isFavorite: next } }); setDraft((current) => current ? { ...current, preference: { ...current.preference, isFavorite: next } } : current); await window.electronAPI.teamFile.setPreference(workspaceId, fileId, { isFavorite: next }) }

  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="right" className="w-full sm:max-w-md p-0"><div className="flex h-full flex-col"> <SheetHeader className="border-b px-5 py-4"><SheetTitle className="pr-8 truncate">{entry?.name || '资料详情'}</SheetTitle><p className="text-xs text-muted-foreground truncate">{entry?.path}</p></SheetHeader>{!fileId ? <div className="p-5 text-sm text-muted-foreground">该条目正在同步稳定资料身份，请刷新后重试。</div> : loading && !draft ? <div className="flex flex-1 items-center justify-center"><Loader2 className="animate-spin" /></div> : draft && <div className="flex min-h-0 flex-1 flex-col"><div className="flex-1 overflow-y-auto space-y-5 p-5"><button onClick={toggleFavorite} className="flex items-center gap-2 text-sm"><Heart size={16} className={detail?.preference.isFavorite ? 'fill-rose-500 text-rose-500' : ''} />{detail?.preference.isFavorite ? '已收藏' : '收藏'}</button>{conflict && <div className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">资料已被他人更新。你的草稿仍保留；请加载最新版本后确认再保存。<button className="ml-2 underline" onClick={() => { setConflict(false); void load() }}>加载最新</button></div>}<label className="block text-sm font-medium">描述<textarea value={draft.description} maxLength={2000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-2 min-h-28 w-full rounded-md border bg-transparent p-2 text-sm" placeholder="补充这份资料的背景、用途或说明…" /></label><label className="block text-sm font-medium">状态<select value={draft.statusId || ''} onChange={(e) => setDraft({ ...draft, statusId: e.target.value || null })} className="mt-2 w-full rounded-md border bg-transparent p-2 text-sm"><option value="">未设置</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label><label className="block text-sm font-medium">负责人<select value={draft.primaryOwnerId || ''} onChange={(e) => setDraft({ ...draft, primaryOwnerId: e.target.value || null })} className="mt-2 w-full rounded-md border bg-transparent p-2 text-sm"><option value="">未分配</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></label><div><p className="text-sm font-medium">标签</p><div className="mt-2 flex flex-wrap gap-2">{tags.length ? tags.map((tag) => <button key={tag.id} onClick={() => toggleTag(tag.id)} className={`rounded-full border px-2 py-1 text-xs ${draft.tags.some((item) => item.id === tag.id) ? 'bg-primary text-primary-foreground' : ''}`}><Tag size={11} className="mr-1 inline" />{tag.name}</button>) : <p className="text-xs text-muted-foreground">暂无可用标签（Owner/Admin 可在后续管理页创建）。</p>}</div></div><div><p className="text-sm font-medium">活动</p><div className="mt-2 space-y-2">{activities.length ? activities.map((activity) => <div key={activity.id} className="text-xs text-muted-foreground"><span className="text-foreground">{activity.type}</span> · {new Date(activity.createdAt).toLocaleString()}</div>) : <p className="text-xs text-muted-foreground">暂无活动</p>}</div></div></div><div className="border-t p-4"><button disabled={saving || conflict} onClick={save} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}保存更改</button></div></div>}</div></SheetContent></Sheet>
}
