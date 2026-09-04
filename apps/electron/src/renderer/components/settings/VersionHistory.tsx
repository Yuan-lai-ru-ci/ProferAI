/**
 * VersionHistory - 版本历史组件
 *
 * 显示应用内置 CHANGELOG 记录的每次发布更新内容（不依赖 GitHub）。
 * 遵循 Profer 设置页统一样式：SettingsSection + SettingsCard + SettingsRow。
 */

import * as React from 'react'
import type { ChangelogEntry } from '@profer/shared'
import { ChevronDown, ChevronUp, History, RefreshCw, Sparkles } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@profer/ui'
import { cn } from '@/lib/utils'
import { SettingsCard } from './primitives'

/**
 * 格式化发布日期
 */
function formatReleaseDate(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateString
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays <= 0) return '今天发布'
  if (diffDays === 1) return '昨天发布'
  if (diffDays < 7) return `${diffDays} 天前发布`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前发布`

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * 单条版本记录卡片
 */
function VersionEntry({ entry, index }: {
  entry: ChangelogEntry
  index: number
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(index === 0)

  const toggle = (): void => setExpanded(v => !v)

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
      {/* 卡片头部：版本信息 + 展开按钮 */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {index === 0 && <Sparkles size={14} className="text-primary shrink-0" />}
          <span className="text-sm font-medium font-mono shrink-0">v{entry.version}</span>
          {index === 0 && (
            <span className="text-xs text-primary shrink-0">最新</span>
          )}
          <span className="text-xs text-muted-foreground truncate">
            {formatReleaseDate(entry.date)}
          </span>
        </div>
        {expanded ? (
          <ChevronUp size={16} className="text-muted-foreground shrink-0 ml-2" />
        ) : (
          <ChevronDown size={16} className="text-muted-foreground shrink-0 ml-2" />
        )}
      </button>

      {/* 更新内容（展开时显示） */}
      {expanded && entry.notes && (
        <div className="border-t border-border/50 px-4 py-3">
          <div className="rounded-md bg-muted/35 px-4 py-3 overflow-x-auto">
            <div className="prose dark:prose-invert max-w-none text-sm prose-p:my-1.5 prose-p:leading-[1.65] prose-li:my-1 prose-li:leading-[1.65] prose-ul:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children: preChildren }) => <CodeBlock>{preChildren}</CodeBlock>,
                  a: ({ href, children: linkChildren, ...linkProps }) => (
                    <a
                      {...linkProps}
                      href={href ?? undefined}
                      onClick={(e) => {
                        e.preventDefault()
                        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                          window.electronAPI.openExternal(href)
                        }
                      }}
                      title={href ?? undefined}
                    >
                      {linkChildren}
                    </a>
                  ),
                }}
              >
                {entry.notes}
              </Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * VersionHistory 组件
 */
export function VersionHistory(): React.ReactElement {
  const [entries, setEntries] = React.useState<ChangelogEntry[]>([])
  const [expanded, setExpanded] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const mounted = React.useRef(true)

  // 加载版本历史
  const loadChangelog = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.electronAPI?.updater?.getChangelog?.()
      if (mounted.current) setEntries(data || [])
    } catch (err) {
      console.error('[版本历史] 加载失败:', err)
      if (mounted.current) setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  // 仅在用户打开历史时加载，避免“关于”页首屏产生无意义的 IPC 请求。
  React.useEffect(() => {
    mounted.current = true
    if (expanded && entries.length === 0 && !error) {
      loadChangelog()
    }
    return (): void => { mounted.current = false }
  }, [expanded, entries.length, error, loadChangelog])

  const content = (): React.ReactNode => {
    if (loading && entries.length === 0) {
      return <div className="py-7 text-center text-sm text-muted-foreground">正在加载更新历史…</div>
    }
    if (error) {
      return <div className="py-7 text-center text-sm text-destructive">{error}</div>
    }
    if (entries.length === 0) {
      return <div className="py-7 text-center text-sm text-muted-foreground">暂无更新历史</div>
    }
    return (
      <div className="space-y-2 px-3 pb-3">
        {entries.map((entry, index) => (
          <VersionEntry key={entry.version} entry={entry} index={index} />
        ))}
      </div>
    )
  }

  return (
    <SettingsCard divided={false} className="overflow-hidden">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <History size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">更新历史</div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">查看每个版本的更新内容，离线可读</p>
          </div>
          {expanded ? <ChevronUp size={16} className="shrink-0 text-muted-foreground" /> : <ChevronDown size={16} className="shrink-0 text-muted-foreground" />}
        </button>
        {expanded && (
          <Button
            size="icon"
            variant="ghost"
            disabled={loading}
            onClick={() => void loadChangelog()}
            className="mr-2 size-8 shrink-0"
            title="刷新更新历史"
            aria-label="刷新更新历史"
          >
            <RefreshCw size={15} className={cn(loading && 'animate-spin')} />
          </Button>
        )}
      </div>
      {expanded && <div className="border-t border-border/60 pt-3">{content()}</div>}
    </SettingsCard>
  )
}
