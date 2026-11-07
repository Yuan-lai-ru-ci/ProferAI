import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Code2, Eye, FileText, Folder, Loader2, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import type { GlobalMemorySummary, SkillFileNode } from '@profer/shared'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { MessageResponse } from '@/components/ai-elements/message'
import {
  FullScreenView,
  ViewBody,
  ViewHeader,
  ViewSearchField,
} from '@/components/app-shell/FullScreenView'
import { activeViewAtom, globalProfileFileAtom } from '@/atoms/active-view'
import { cn } from '@/lib/utils'

type SearchHit = { relativePath: string; content: string; startIndex: number; endIndex: number }

type ViewMode = 'preview' | 'edit'

function flattenFiles(nodes: SkillFileNode[]): SkillFileNode[] {
  return nodes.flatMap((node) => node.type === 'directory' ? flattenFiles(node.children ?? []) : [node])
}

function FileTree({
  nodes,
  selected,
  onSelect,
  level = 0,
}: {
  nodes: SkillFileNode[]
  selected: string
  onSelect: (path: string) => void
  level?: number
}): React.ReactElement {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => node.type === 'directory' ? (
        <div key={node.relativePath} className="pt-2">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
            <Folder className="size-3.5" />
            <span className="truncate">{node.name}</span>
          </div>
          <div className="ml-3 border-l border-border/60 pl-1">
            <FileTree nodes={node.children ?? []} selected={selected} onSelect={onSelect} level={level + 1} />
          </div>
        </div>
      ) : (
        <button
          key={node.relativePath}
          type="button"
          onClick={() => onSelect(node.relativePath)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            selected === node.relativePath
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          style={{ paddingLeft: `${8 + Math.min(level, 2) * 4}px` }}
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate" title={node.relativePath}>{node.name}</span>
        </button>
      ))}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function GlobalMemoryFilesView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const initialPath = useAtomValue(globalProfileFileAtom)
  const [summary, setSummary] = React.useState<GlobalMemorySummary | null>(null)
  const [files, setFiles] = React.useState<SkillFileNode[]>([])
  const [selectedPath, setSelectedPath] = React.useState(initialPath)
  const [content, setContent] = React.useState('')
  const [savedContent, setSavedContent] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<SearchHit[]>([])
  const [searchRan, setSearchRan] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [searching, setSearching] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<ViewMode>('preview')
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (path = initialPath): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextSummary, nextFiles] = await Promise.all([
        window.electronAPI.getGlobalMemorySummary(),
        window.electronAPI.listGlobalMemoryFiles(),
      ])
      const available = flattenFiles(nextFiles)
      const nextPath = available.some((file) => file.relativePath === path)
        ? path
        : (available.find((file) => file.relativePath === 'MEMORY.md')?.relativePath ?? available[0]?.relativePath ?? '')
      setSummary(nextSummary)
      setFiles(nextFiles)
      setSelectedPath(nextPath)
      setSearchRan(false)
      setHits([])
      if (nextPath) {
        const file = await window.electronAPI.readGlobalMemoryFile(nextPath)
        setContent(file.content ?? '')
        setSavedContent(file.content ?? '')
      } else {
        setContent('')
        setSavedContent('')
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast.error(`读取全局记忆失败：${message}`)
    } finally {
      setLoading(false)
    }
  }, [initialPath])

  React.useEffect(() => { void load() }, [load])

  const selectFile = async (path: string): Promise<void> => {
    if (path === selectedPath) return
    if (content !== savedContent && !window.confirm('当前文件有未保存修改，确定切换文件吗？')) return
    setLoadingFile(true)
    try {
      const file = await window.electronAPI.readGlobalMemoryFile(path)
      setSelectedPath(path)
      setContent(file.content ?? '')
      setSavedContent(file.content ?? '')
      setViewMode('preview')
      setSearchRan(false)
      setHits([])
    } catch (cause) {
      toast.error(`读取文件失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setLoadingFile(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!selectedPath || content === savedContent) return
    setSaving(true)
    try {
      await window.electronAPI.writeGlobalMemoryFile(selectedPath, content)
      setSavedContent(content)
      setSummary(await window.electronAPI.getGlobalMemorySummary())
      toast.success('全局记忆已保存')
    } catch (cause) {
      toast.error(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selectedPath || selectedPath === 'MEMORY.md' || !window.confirm(`确定删除 ${selectedPath}？`)) return
    try {
      await window.electronAPI.deleteGlobalMemoryFile(selectedPath)
      toast.success('记忆文件已删除')
      await load('MEMORY.md')
    } catch (cause) {
      toast.error(`删除失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const search = async (): Promise<void> => {
    const value = query.trim()
    if (!value) {
      setHits([])
      setSearchRan(false)
      return
    }
    setSearching(true)
    setSearchRan(true)
    try {
      setHits(await window.electronAPI.searchGlobalMemory(value, 20))
    } catch (cause) {
      toast.error(`搜索失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setSearching(false)
    }
  }

  const dirty = content !== savedContent

  return (
    <FullScreenView region="user-profile" controlsId="global-memory-files">
      <ViewHeader
        width="standard"
        title="全局记忆"
        subtitle={summary ? `${summary.fileCount} 个文件 · ${formatBytes(summary.totalSize)}` : undefined}
        back={{ label: '返回我的画像', onClick: () => setActiveView('user-profile') }}
        actions={
          <ViewSearchField
            value={query}
            onChange={(value) => { setQuery(value); setSearchRan(false); setHits([]) }}
            onSubmit={() => void search()}
            submitLabel="搜索"
            placeholder="搜索记忆正文"
            label="搜索记忆正文"
          />
        }
      />

      <ViewBody width="standard" className="pb-5">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-surface-raised shadow-sm">
          <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row">
            <aside className="flex min-h-0 flex-col border-b border-border/60 min-[900px]:w-[240px] min-[900px]:shrink-0 min-[900px]:border-b-0 min-[900px]:border-r">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
                <div className="text-[13px] font-medium text-foreground/80">记忆文件</div>
                <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => void load(selectedPath)} aria-label="刷新记忆文件列表">
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {loading ? (
                  <div className="flex justify-center p-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
                ) : files.length > 0 ? (
                  <FileTree nodes={files} selected={selectedPath} onSelect={(path) => void selectFile(path)} />
                ) : (
                  <div className="px-2 py-8 text-center text-xs text-muted-foreground">暂无记忆文件</div>
                )}
                {error && <p role="alert" className="mt-4 px-2 text-xs text-destructive">{error}</p>}
              </div>
              <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">跨工作区共享</div>
            </aside>

            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {searchRan ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
                    <Search className="size-3.5 text-muted-foreground" />
                    搜索结果
                    <span className="text-xs font-normal text-muted-foreground">{searching ? '搜索中...' : `${hits.length} 条`}</span>
                  </div>
                  {searching ? (
                    <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">搜索记忆中...</div>
                  ) : hits.length === 0 ? (
                    <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">没有命中的记忆</div>
                  ) : (
                    <div className="space-y-1.5">
                      {hits.map((hit) => (
                        <button
                          key={`${hit.relativePath}-${hit.startIndex}`}
                          type="button"
                          onClick={() => void selectFile(hit.relativePath)}
                          className="block w-full rounded-lg border border-border/50 px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-accent/50"
                        >
                          <div className="truncate text-[13px] font-medium text-foreground">{hit.relativePath}</div>
                          <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{hit.content}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-foreground">{selectedPath || '未选择文件'}</span>
                          {dirty && <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">未保存</span>}
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-muted-foreground">{selectedPath === 'MEMORY.md' ? '记忆索引' : '主题记忆'}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {selectedPath && (
                        <div className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.05] p-0.5">
                          <button type="button" aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', viewMode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                            <Eye className="size-3.5" />预览
                          </button>
                          <button type="button" aria-pressed={viewMode === 'edit'} onClick={() => setViewMode('edit')} className={cn('flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', viewMode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                            <Code2 className="size-3.5" />编辑
                          </button>
                        </div>
                      )}
                      {selectedPath && selectedPath !== 'MEMORY.md' && (
                        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => void remove()} aria-label="删除记忆文件">
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                      {selectedPath && (
                        <Button size="sm" className="h-8" onClick={() => void save()} disabled={!dirty || saving || loadingFile}>
                          {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />}
                          {saving ? '保存中...' : '保存'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {loadingFile ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />读取文件中...</div>
                  ) : !selectedPath ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">选择一个记忆文件</div>
                  ) : viewMode === 'edit' ? (
                    <textarea
                      value={content}
                      onChange={(event) => setContent(event.target.value)}
                      spellCheck={false}
                      className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
                      placeholder="# MEMORY\n\n写下稳定、可复用的全局用户记忆。"
                    />
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto p-5">
                      {content.trim() ? <MessageResponse className="text-[14px] prose-headings:scroll-mt-4" basePath=".">{content}</MessageResponse> : <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">文件为空</div>}
                    </div>
                  )}
                </>
              )}
            </main>
          </div>
        </section>
      </ViewBody>
    </FullScreenView>
  )
}
