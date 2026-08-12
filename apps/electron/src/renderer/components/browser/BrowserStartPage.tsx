import * as React from 'react'
import type { BrowserStartPageState } from '@profer/shared'
import { Bookmark, Clock, Globe2, Search, Sparkles, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface BrowserStartPageProps {
  state: BrowserStartPageState
  /** 提交搜索或点击书签/历史时导航当前标签。 */
  onNavigate: (url: string) => void
  onRemoveBookmark?: (id: string) => void
  onClearHistory?: () => void
}

function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''
  // 1. 已带协议：直接当作完整 URL。
  if (/^https?:\/\//i.test(value)) return value
  // 2. 形如域名（含 "." 且无空格）：补 https://。
  //    排除 "1.2" 之类纯数字点号；允许带路径、端口、查询，避免把 "bilibili.com/" 误判为搜索词。
  if (!/\s/.test(value) && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(value)) {
    return `https://${value}`
  }
  // 3. 其余（裸词、含空格、中文等）当作搜索词，走搜索引擎。
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
}

export function BrowserStartPage({ state, onNavigate, onRemoveBookmark, onClearHistory }: BrowserStartPageProps): React.ReactElement {
  const [query, setQuery] = React.useState('')

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    const target = normalizeUrl(query)
    if (target) onNavigate(target)
  }

  const openItem = (url: string) => {
    if (url) onNavigate(url)
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin bg-background/40">
      <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-14">
        {/* Logo + 标题 */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Globe2 className="size-7" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-foreground">新标签页</h1>
            <p className="mt-1 text-xs text-muted-foreground">输入网址或搜索词开始浏览</p>
          </div>
        </div>

        {/* 搜索 / 地址框 */}
        <form onSubmit={submit} className="w-full max-w-xl">
          <div className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入网址，或搜索关键词"
              className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              aria-label="搜索或输入网址"
            />
          </div>
        </form>

        {/* 书签九宫格 */}
        {state.bookmarks.length > 0 && (
          <section className="mt-10 w-full">
            <h2 className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Bookmark className="size-3.5" /> 书签
            </h2>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {state.bookmarks.map((bookmark) => (
                <div key={bookmark.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => openItem(bookmark.url)}
                    className="flex w-full flex-col items-center gap-2 rounded-xl border border-transparent p-3 text-center transition-colors hover:border-border hover:bg-muted/40"
                    aria-label={`打开书签 ${bookmark.title}`}
                  >
                    <span className="flex size-10 items-center justify-center overflow-hidden rounded-lg bg-background shadow-sm ring-1 ring-border/50">
                      {bookmark.favicon ? (
                        <img src={bookmark.favicon} alt="" className="size-6 object-contain" loading="lazy" />
                      ) : (
                        <Globe2 className="size-5 text-muted-foreground" />
                      )}
                    </span>
                    <span className="line-clamp-2 w-full text-[11px] leading-tight text-foreground/90">{bookmark.title}</span>
                  </button>
                  {onRemoveBookmark && (
                    <button
                      type="button"
                      onClick={() => onRemoveBookmark(bookmark.id)}
                      className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-full bg-muted text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/90 hover:text-white group-hover:flex group-hover:opacity-100"
                      aria-label={`删除书签 ${bookmark.title}`}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 最近访问 */}
        {state.recentHistory.length > 0 && (
          <section className="mt-8 w-full">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Clock className="size-3.5" /> 最近访问
              </h2>
              {onClearHistory && (
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground" onClick={onClearHistory}>
                  <Trash2 className="mr-1 size-3" /> 清空
                </Button>
              )}
            </div>
            <div className="space-y-0.5">
              {state.recentHistory.map((entry) => (
                <button
                  key={entry.url}
                  type="button"
                  onClick={() => openItem(entry.url)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/50"
                  aria-label={`打开 ${entry.title}`}
                >
                  <Globe2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground/90">{entry.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{entry.url}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* 空状态提示 */}
        {state.bookmarks.length === 0 && state.recentHistory.length === 0 && (
          <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
            <Sparkles className="size-5" />
            <p className="text-xs">浏览过程中点击地址栏的星形按钮收藏页面</p>
            <p className="text-[10px]">书签和最近访问会保存在本机</p>
          </div>
        )}
      </div>
    </div>
  )
}
