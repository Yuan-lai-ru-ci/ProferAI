import * as React from 'react'
import { BookOpen, FilePlus2, Loader2, RefreshCw } from 'lucide-react'
import type { TeamMemoryDocument } from '@profer/shared'
import { cn } from '@/lib/utils'

export function TeamMemoryPanel({ workspaceId, onOpen }: { workspaceId: string; onOpen: (id?: string) => void }) {
  const [items, setItems] = React.useState<Array<Omit<TeamMemoryDocument, 'content'>>>([])
  const [loading, setLoading] = React.useState(true)
  const load = React.useCallback(async () => {
    setLoading(true)
    const result = await window.electronAPI.teamMemory.list(workspaceId)
    if (result.ok) setItems(result.data ?? [])
    setLoading(false)
  }, [workspaceId])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => window.electronAPI.sse.onEvent((eventWorkspaceId, event) => {
    if (eventWorkspaceId === workspaceId && event.type === 'team_memory_changed') void load()
  }), [workspaceId, load])

  return <div className="flex h-full flex-col">
    <div className="flex h-11 items-center gap-1.5 border-b border-border/50 px-3">
      <BookOpen size={15} className="text-primary" /><span className="flex-1 text-xs font-medium">团队记忆</span>
      <button type="button" onClick={() => onOpen()} title="新建团队记忆" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><FilePlus2 size={15} /></button>
      <button type="button" onClick={() => void load()} title="刷新" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><RefreshCw size={15} className={cn(loading && 'animate-spin')} /></button>
    </div>
    <div className="flex-1 overflow-y-auto p-2">
      {loading ? <div className="flex h-20 items-center justify-center"><Loader2 size={16} className="animate-spin" /></div>
        : items.length === 0 ? <div className="p-4 text-center text-xs text-muted-foreground">暂无团队记忆<br />创建项目背景、决策或规范，供所有成员和 Agent 共同使用。</div>
          : items.map((item) => <button key={item.id} type="button" onClick={() => onOpen(item.id)} aria-label={`打开团队记忆：${item.title}`} className="mb-1 flex w-full flex-col rounded-lg px-2 py-2 text-left hover:bg-accent"><span className="truncate text-xs font-medium">{item.title}</span><span className="truncate text-[10px] text-muted-foreground">{item.path} · v{item.version}</span></button>)}
    </div>
  </div>
}
