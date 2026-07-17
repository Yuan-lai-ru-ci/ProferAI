/**
 * TeamAnnouncements — 团队公告面板
 *
 * 独立面板，展示工作区公告列表，置顶优先，Markdown 内容渲染。
 * owner/admin 可创建和删除公告。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { Loader2, Pin, Plus, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'

// ===== 类型 =====

interface Announcement {
  id: string
  workspaceId: string
  authorId: string
  authorName: string
  title: string
  content: string
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

interface TeamAnnouncementsProps {
  workspaceId: string
  workspaceRole?: string
  eventVersion?: number
}

// ===== 创建公告弹窗 =====

function CreateAnnouncementDialog({
  open,
  onClose,
  workspaceId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string
  onCreated: () => void
}): React.ReactElement | null {
  const [title, setTitle] = React.useState('')
  const [content, setContent] = React.useState('')
  const [isPinned, setIsPinned] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [isComposing, setIsComposing] = React.useState(false)

  if (!open) return null

  const handleSubmit = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) { toast.error('请输入公告标题'); return }
    setSubmitting(true)
    try {
      await window.electronAPI.team.createAnnouncement?.(workspaceId, trimmedTitle, content.trim(), isPinned)
      toast.success('公告已发布')
      setTitle('')
      setContent('')
      setIsPinned(false)
      onCreated()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发布失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="bg-popover border rounded-2xl shadow-2xl p-6 w-[520px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">发布公告</h3>
          <button className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-accent" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <input
          autoFocus
          type="text"
          className="h-10 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 mb-3"
          placeholder="公告标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing) { e.preventDefault(); handleSubmit() } }}
        />

        <textarea
          className="flex-1 min-h-[160px] px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none mb-3 font-mono"
          placeholder="支持 Markdown 格式..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
        />

        <label className="flex items-center gap-2 mb-4 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={isPinned}
            onChange={(e) => setIsPinned(e.target.checked)}
            className="rounded"
          />
          <Pin size={12} />
          置顶公告
        </label>

        <div className="flex gap-2">
          <button className="flex-1 h-9 rounded-lg border text-xs font-medium hover:bg-accent" onClick={onClose}>
            取消
          </button>
          <button
            className="flex-1 h-9 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={!title.trim() || submitting}
            onClick={handleSubmit}
          >
            {submitting ? '发布中...' : '发布'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== 格式化相对时间 =====

function formatTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

// ===== 主组件 =====

export function TeamAnnouncements({ workspaceId, workspaceRole, eventVersion }: TeamAnnouncementsProps): React.ReactElement {
  const [announcements, setAnnouncements] = React.useState<Announcement[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showCreate, setShowCreate] = React.useState(false)
  const mountedRef = React.useRef(true)
  const canPost = workspaceRole === 'owner' || workspaceRole === 'admin'

  const loadAnnouncements = React.useCallback(async () => {
    if (!window.electronAPI.team.getAnnouncements) return
    try {
      const data = await window.electronAPI.team.getAnnouncements(workspaceId)
      if (!mountedRef.current) return
      setAnnouncements(data as Announcement[])
    } catch { /* ignore */ }
    finally { if (mountedRef.current) setLoading(false) }
  }, [workspaceId])

  // 初始加载
  React.useEffect(() => {
    mountedRef.current = true
    loadAnnouncements()
    return () => { mountedRef.current = false }
  }, [loadAnnouncements])

  // SSE 事件触发刷新
  React.useEffect(() => {
    if (!eventVersion || eventVersion <= 0) return
    loadAnnouncements()
  }, [eventVersion, loadAnnouncements])

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.team.deleteAnnouncement?.(workspaceId, id)
      toast.success('已删除')
      loadAnnouncements()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 flex-shrink-0">
        <span className="text-xs font-medium text-muted-foreground">
          {announcements.length > 0 ? `${announcements.length} 条公告` : '暂无公告'}
        </span>
        {canPost && (
          <button
            className="h-7 px-2 rounded-md text-xs font-medium hover:bg-accent flex items-center gap-1"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={12} />
            发布公告
          </button>
        )}
      </div>

      {/* 公告列表 */}
      <ScrollArea className="flex-1">
        {announcements.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <Pin size={24} strokeWidth={1} />
            <p className="text-xs">暂无公告</p>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            {announcements.map((ann) => (
              <div
                key={ann.id}
                className={cn(
                  'rounded-xl border p-4 transition-colors',
                  ann.isPinned
                    ? 'border-amber-500/30 bg-amber-500/5'
                    : 'border-border/50 bg-background/50',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1">
                      {ann.isPinned && <Pin size={11} className="text-amber-500 flex-shrink-0" />}
                      <h4 className="text-sm font-semibold truncate">{ann.title}</h4>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-2">
                      <span>{ann.authorName}</span>
                      <span>·</span>
                      <span>{formatTime(ann.createdAt)}</span>
                    </div>
                    {ann.content && (
                      <div className="prose prose-sm dark:prose-invert max-w-none text-xs [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:list-disc [&_ul]:pl-4 [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded-lg [&_a]:text-primary [&_a]:underline">
                        <ReactMarkdown>{ann.content}</ReactMarkdown>
                      </div>
                    )}
                  </div>
                  {/* 删除按钮 */}
                  {canPost && (
                    <button
                      className="h-6 w-6 rounded flex items-center justify-center opacity-0 hover:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-destructive flex-shrink-0 transition-opacity"
                      title="删除"
                      onClick={() => handleDelete(ann.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* 创建公告弹窗 */}
      <CreateAnnouncementDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        workspaceId={workspaceId}
        onCreated={loadAnnouncements}
      />
    </div>
  )
}
