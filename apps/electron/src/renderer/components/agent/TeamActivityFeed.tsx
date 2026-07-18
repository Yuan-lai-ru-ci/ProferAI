/**
 * TeamActivityFeed — 团队活动动态面板
 *
 * 复用已有 GET /v1/workspaces/:id/audit-logs API，
 * 以时间线形式展示工作区的操作记录。
 */

import * as React from 'react'
import { Loader2, Upload, Trash2, Pencil, UserPlus, LogIn, UserMinus, Shield, Plus, FolderOpen, Move, RefreshCw, type LucideProps } from 'lucide-react'
import { cn } from '@/lib/utils'

// ===== 类型 =====

interface AuditEntry {
  action: string
  user_email: string
  entity_type: string
  entity_id: string
  detail: string
  created_at: number
}

interface TeamActivityFeedProps {
  workspaceId: string
  /** SSE 事件版本号，每次事件到达时 +1 触发刷新 */
  eventVersion?: number
}

// ===== 操作类型映射 =====

interface ActionMeta {
  icon: React.ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & React.RefAttributes<SVGSVGElement>>
  label: (entry: AuditEntry) => string
  color: string
}

function getActionMeta(action: string): ActionMeta {
  if (action.startsWith('file.upload')) {
    return {
      icon: Upload,
      color: 'text-blue-500',
      label: (e) => {
        const detail = tryParseDetail(e.detail)
        return `上传了 ${detail?.fileName || e.entity_id || '文件'}`
      },
    }
  }
  if (action.startsWith('file.delete')) {
    return {
      icon: Trash2,
      color: 'text-red-500',
      label: (e) => `删除了 ${e.entity_id || '文件'}`,
    }
  }
  if (action.startsWith('file.move')) {
    return {
      icon: Move,
      color: 'text-amber-500',
      label: (e) => `移动了 ${e.entity_id || '文件'}`,
    }
  }
  if (action.startsWith('file.rename')) {
    return {
      icon: Pencil,
      color: 'text-amber-500',
      label: (e) => `重命名了 ${e.entity_id || '文件'}`,
    }
  }
  if (action.startsWith('member.invite')) {
    return {
      icon: UserPlus,
      color: 'text-green-500',
      label: (e) => {
        const detail = tryParseDetail(e.detail)
        const email = detail?.invited || e.entity_id || ''
        return `邀请了 ${email}`
      },
    }
  }
  if (action.startsWith('member.join') || action === 'member.add') {
    return {
      icon: LogIn,
      color: 'text-green-500',
      label: (_e) => '加入了工作区',
    }
  }
  if (action.startsWith('member.remove')) {
    return {
      icon: UserMinus,
      color: 'text-orange-500',
      label: (_e) => '被移出工作区',
    }
  }
  if (action.startsWith('member.update_role')) {
    return {
      icon: Shield,
      color: 'text-purple-500',
      label: (e) => {
        const detail = tryParseDetail(e.detail)
        const role = detail?.newRole || detail?.role || ''
        return `角色变更为 ${roleLabel(role)}`
      },
    }
  }
  if (action.startsWith('workspace.create')) {
    return {
      icon: Plus,
      color: 'text-blue-500',
      label: (_e) => '创建了工作区',
    }
  }
  if (action.startsWith('workspace.delete')) {
    return {
      icon: Trash2,
      color: 'text-red-500',
      label: (_e) => '删除了工作区',
    }
  }
  if (action.startsWith('workspace.restore')) {
    return {
      icon: FolderOpen,
      color: 'text-green-500',
      label: (_e) => '恢复了工作区',
    }
  }
  // 默认
  return {
    icon: RefreshCw,
    color: 'text-muted-foreground',
    label: (e) => e.action,
  }
}

function tryParseDetail(detail: string): Record<string, string> | null {
  try {
    return JSON.parse(detail)
  } catch {
    return null
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case 'owner': return '拥有者'
    case 'admin': return '管理员'
    case 'member': return '成员'
    case 'viewer': return '观察者'
    default: return role
  }
}

/** 相对时间 */
function formatRelativeTime(ts: number): string {
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

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// ===== 组件 =====

export function TeamActivityFeed({ workspaceId, eventVersion }: TeamActivityFeedProps): React.ReactElement {
  const [entries, setEntries] = React.useState<AuditEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [hasMore, setHasMore] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const oldestRef = React.useRef<number>(0)
  const mountedRef = React.useRef(true)

  // 首次加载
  React.useEffect(() => {
    mountedRef.current = true
    setLoading(true)
    window.electronAPI.team.getAuditLogs
      ? window.electronAPI.team.getAuditLogs(workspaceId, 30)
          .then((data: AuditEntry[]) => {
            if (!mountedRef.current) return
            setEntries(data)
            setHasMore(data.length >= 30)
            if (data.length > 0) {
              oldestRef.current = data[data.length - 1]!.created_at
            }
          })
          .catch(() => {})
          .finally(() => { if (mountedRef.current) setLoading(false) })
      : setLoading(false)

    return () => { mountedRef.current = false }
  }, [workspaceId])

  // SSE 事件触发刷新（重新加载最新条目）
  React.useEffect(() => {
    if (!eventVersion || eventVersion <= 0) return
    window.electronAPI.team.getAuditLogs
      ? window.electronAPI.team.getAuditLogs(workspaceId, 30)
          .then((data: AuditEntry[]) => {
            if (!mountedRef.current) return
            setEntries(data)
          })
          .catch(() => {})
      : undefined
  }, [eventVersion, workspaceId])

  // 加载更多（向前翻页）
  const handleLoadMore = React.useCallback(async () => {
    if (!window.electronAPI.team.getAuditLogs || !hasMore) return
    setLoadingMore(true)
    try {
      const data: AuditEntry[] = await window.electronAPI.team.getAuditLogs(workspaceId, 30, oldestRef.current)
      if (!mountedRef.current) return
      if (data.length < 30) setHasMore(false)
      if (data.length > 0) {
        oldestRef.current = data[data.length - 1]!.created_at
        setEntries((prev) => [...prev, ...data])
      }
    } catch { /* ignore */ }
    finally { setLoadingMore(false) }
  }, [workspaceId, hasMore])

  // 按日期分组
  const grouped = React.useMemo(() => {
    const groups: Array<{ label: string; entries: AuditEntry[] }> = []
    const today = new Date()
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const yesterdayStart = todayStart - 86_400_000
    const weekStart = todayStart - 6 * 86_400_000

    for (const e of entries) {
      let label: string
      if (e.created_at >= todayStart) label = '今天'
      else if (e.created_at >= yesterdayStart) label = '昨天'
      else if (e.created_at >= weekStart) label = '本周'
      else label = '更早'

      const last = groups[groups.length - 1]
      if (last && last.label === label) {
        last.entries.push(e)
      } else {
        groups.push({ label, entries: [e] })
      }
    }
    return groups
  }, [entries])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
        <RefreshCw size={20} strokeWidth={1} />
        <p className="text-xs">暂无活动记录</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {grouped.map((group) => (
          <div key={group.label} className="mb-4">
            <div className="sticky top-0 z-10 bg-content-area/95 backdrop-blur-sm py-0.5 mb-2">
              <span className="text-[11px] font-medium text-muted-foreground">{group.label}</span>
            </div>

            <div className="space-y-0.5">
              {group.entries.map((entry, idx) => {
                const meta = getActionMeta(entry.action)
                const Icon = meta.icon
                return (
                  <div
                    key={`${entry.created_at}-${idx}`}
                    className="flex items-start gap-2.5 py-1.5 px-2 rounded-lg hover:bg-accent/30 transition-colors"
                  >
                    {/* 时间 */}
                    <span className="text-[10px] text-muted-foreground/60 w-10 text-right pt-0.5 flex-shrink-0" title={new Date(entry.created_at).toLocaleString('zh-CN')}>
                      {formatTime(entry.created_at)}
                    </span>

                    {/* 图标 */}
                    <span className={cn('flex-shrink-0 mt-0.5', meta.color)}>
                      <Icon size={14} />
                    </span>

                    {/* 内容 */}
                    <div className="flex-1 min-w-0">
                      <span className="text-xs">
                        <span className="font-medium">{entry.user_email || '未知用户'}</span>
                        {' '}
                        <span className="text-muted-foreground">{meta.label(entry)}</span>
                      </span>
                      <span className="block text-[10px] text-muted-foreground/60 mt-0.5">{formatRelativeTime(entry.created_at)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 加载更多 */}
      {hasMore && (
        <div className="flex-shrink-0 px-4 py-2 border-t border-border/50">
          <button
            className="w-full h-8 rounded-lg text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            加载更多
          </button>
        </div>
      )}
    </div>
  )
}
