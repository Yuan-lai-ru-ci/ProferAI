import * as React from 'react'
import { ArrowLeft, Loader2, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import type { TeamMemoryDocument } from '@profer/shared'

export function TeamMemoryEditor({ workspaceId, memoryId, onClose }: { workspaceId: string; memoryId?: string; onClose: () => void }) {
  const [doc, setDoc] = React.useState<TeamMemoryDocument | null>(null)
  const [path, setPath] = React.useState('团队总览/未命名.md')
  const [title, setTitle] = React.useState('')
  const [content, setContent] = React.useState('')
  const [loading, setLoading] = React.useState(!!memoryId)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [remoteChanged, setRemoteChanged] = React.useState(false)
  const [conflictDraft, setConflictDraft] = React.useState<{ path: string; title: string; content: string } | null>(null)
  const [saving, setSaving] = React.useState(false)
  const loadRequestRef = React.useRef(0)

  const applyDocument = React.useCallback((next: TeamMemoryDocument) => {
    setDoc(next); setPath(next.path); setTitle(next.title); setContent(next.content)
  }, [])
  const load = React.useCallback(async () => {
    if (!memoryId) return
    const requestId = ++loadRequestRef.current
    setLoading(true); setLoadError(null)
    const result = await window.electronAPI.teamMemory.read(workspaceId, memoryId)
    if (requestId !== loadRequestRef.current) return
    if (result.ok && result.data) applyDocument(result.data)
    else setLoadError(result.error || '读取团队记忆失败')
    setLoading(false)
  }, [workspaceId, memoryId, applyDocument])

  React.useEffect(() => { void load(); return () => { loadRequestRef.current += 1 } }, [load])
  React.useEffect(() => window.electronAPI.sse.onEvent((eventWorkspaceId, event) => {
    if (memoryId && eventWorkspaceId === workspaceId && event.type === 'team_memory_changed' && (event.data as { memoryId?: string }).memoryId === memoryId) setRemoteChanged(true)
  }), [workspaceId, memoryId])

  const refreshLatest = async () => {
    setConflictDraft({ path, title, content })
    await load()
    setRemoteChanged(false)
    toast.success('已加载最新版本；原草稿已保留，可恢复后手动合并')
  }
  const save = async () => {
    setSaving(true)
    const input = { path, title, content, changeSummary: '手动更新' }
    const result = doc
      ? await window.electronAPI.teamMemory.update(workspaceId, doc.id, { ...input, expectedVersion: doc.version })
      : await window.electronAPI.teamMemory.create(workspaceId, input)
    setSaving(false)
    if (result.ok && result.data) { applyDocument(result.data); setRemoteChanged(false); toast.success('团队记忆已保存'); return }
    if (result.conflict) { setConflictDraft({ path, title, content }); setRemoteChanged(true); toast.error('其他成员刚更新此记忆；你的草稿已保留，请加载最新版本后手动合并') }
    else toast.error(result.error || '保存失败')
  }

  if (loading) return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>
  if (loadError) return <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center text-sm text-muted-foreground"><span>{loadError}</span><button type="button" onClick={() => void load()} className="rounded border px-3 py-1.5 text-xs hover:bg-accent">重试</button></div>

  return <div className="flex h-full min-h-0 flex-col bg-content-area">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-4">
      <button type="button" onClick={onClose} className="h-7 w-7 rounded hover:bg-accent" title="返回 Agent"><ArrowLeft size={15} /></button>
      <span className="flex-1 truncate text-xs font-medium">{doc ? `团队记忆 · ${doc.path}` : '新建团队记忆'}</span>
      {remoteChanged && <button type="button" onClick={() => void refreshLatest()} title="加载最新版本" className="flex h-7 items-center gap-1 rounded border border-amber-500/40 px-2 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"><RefreshCw size={13} />有更新</button>}
      {conflictDraft && <button type="button" onClick={() => { setPath(conflictDraft.path); setTitle(conflictDraft.title); setContent(conflictDraft.content) }} title="恢复保留的草稿" className="h-7 rounded border px-2 text-xs hover:bg-accent">恢复草稿</button>}
      <button type="button" disabled={loading || saving || !title.trim() || !path.trim()} onClick={() => void save()} className="flex h-7 items-center gap-1 rounded bg-primary px-2 text-xs text-primary-foreground disabled:opacity-50"><Save size={13} />{saving ? '保存中' : '保存'}</button>
    </div>
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto p-5">
      <label className="sr-only" htmlFor="team-memory-path">路径</label><input id="team-memory-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="路径，如 决策记录/布局.md" className="h-9 rounded border bg-background px-3 text-sm" />
      <label className="sr-only" htmlFor="team-memory-title">标题</label><input id="team-memory-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" className="h-10 rounded border bg-background px-3 text-base font-medium" />
      <label className="sr-only" htmlFor="team-memory-content">内容</label><textarea id="team-memory-content" value={content} onChange={(e) => setContent(e.target.value)} placeholder="用 Markdown 记录团队共识、项目背景、决策或经验…" className="min-h-[360px] flex-1 resize-none rounded border bg-background p-3 font-mono text-sm leading-6" />
    </div>
  </div>
}
