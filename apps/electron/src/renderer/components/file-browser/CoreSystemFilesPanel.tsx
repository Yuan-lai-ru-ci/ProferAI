/**
 * CoreSystemFilesPanel — 非本机内核的“系统文件”页。
 *
 * 复用工作区/会话文件面板的同一套 FileBrowser（树、图标、右键菜单、重命名与删除确认），
 * 这里只额外提供：地址栏/上一级、此电脑盘符入口、新建文件夹、复制/剪切→粘贴。
 */

import * as React from 'react'
import { ChevronLeft, Copy, FolderPlus, HardDrive, Home, LoaderCircle, Monitor, RefreshCw } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { coreSystemRevealAtom } from '@/atoms/agent-atoms'
import { FileBrowser } from './FileBrowser'
import type { CoreDirectoryListing, CoreFsOverview } from '@profer/shared'

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim() || '操作失败'
}

function segmentsOf(value: string): Array<{ label: string; path: string }> {
  const separator = value.includes('\\') ? '\\' : '/'
  const parts = value.split(/[\\/]+/).filter(Boolean)
  const out: Array<{ label: string; path: string }> = []
  let acc = ''
  for (const part of parts) {
    if (!acc) acc = value.startsWith('/') || value.startsWith('\\') ? `${separator}${part}` : part
    else acc = `${acc.replace(/[\\/]+$/, '')}${separator}${part}`
    out.push({ label: part, path: acc })
  }
  return out
}

function normalizePath(value: string): string {
  const trimmed = value.trim()
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
}

export function CoreSystemFilesPanel(): React.ReactElement {
  const [overview, setOverview] = React.useState<CoreFsOverview | null>(null)
  const [current, setCurrent] = React.useState<{ path: string; parent: string | null } | null>(null)
  const [atComputer, setAtComputer] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [editingPath, setEditingPath] = React.useState(false)
  const [pathDraft, setPathDraft] = React.useState('')
  const [clipboard, setClipboard] = React.useState<{ mode: 'copy' | 'cut'; path: string; name: string } | null>(null)
  const [creatingFolder, setCreatingFolder] = React.useState(false)
  const [newFolderName, setNewFolderName] = React.useState('新建文件夹')
  const [busy, setBusy] = React.useState(false)
  const [inlineError, setInlineError] = React.useState<string | null>(null)
  /** 粘贴/新建后强制 FileBrowser 重新挂载取新列表。 */
  const [reloadKey, setReloadKey] = React.useState(0)
  const pathInputRef = React.useRef<HTMLInputElement>(null)

  const openPath = React.useCallback(async (raw: string): Promise<void> => {
    const path = normalizePath(raw)
    if (!path) return
    setLoading(true)
    setError(null)
    setInlineError(null)
    try {
      const listing: CoreDirectoryListing = await window.electronAPI.listCoreDirectories(path, true)
      setCurrent({ path: listing.path, parent: listing.parent })
      setAtComputer(false)
      setEditingPath(false)
      setReloadKey(key => key + 1)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await window.electronAPI.getCoreFileSystemOverview()
        if (!cancelled) setOverview(info)
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => { if (editingPath) requestAnimationFrame(() => pathInputRef.current?.select()) }, [editingPath])

  // 从会话/工作区文件面板点“在系统文件中显示”：切到对应目录。
  const reveal = useAtomValue(coreSystemRevealAtom)
  React.useEffect(() => {
    if (!reveal?.dir) return
    void openPath(reveal.dir)
  }, [reveal?.ts, reveal?.dir, openPath])

  const loadDirectory = React.useCallback(
    (dirPath: string) => window.electronAPI.listCoreDirectories(dirPath, true).then(result => result.entries),
    [],
  )

  const fileOps = React.useMemo(() => ({
    rename: async (filePath: string, newName: string): Promise<void> => {
      await window.electronAPI.coreFsOp({ op: 'rename', path: filePath, name: newName })
    },
    remove: async (filePath: string): Promise<void> => {
      await window.electronAPI.coreFsOp({ op: 'trash', path: filePath })
    },
  }), [])

  const paste = (): void => {
    if (!clipboard || !current) return
    const target = clipboard
    setBusy(true)
    setInlineError(null)
    void window.electronAPI.coreFsOp({
      op: target.mode === 'copy' ? 'copy' : 'move',
      path: target.path,
      toDir: current.path,
    }).then(() => {
      toast.success(target.mode === 'copy' ? '已复制' : '已移动')
      if (target.mode === 'cut') setClipboard(null)
      setReloadKey(key => key + 1)
    }).catch((err) => {
      setInlineError(errorText(err))
      toast.error(errorText(err))
    }).finally(() => setBusy(false))
  }

  const createFolder = (): void => {
    const name = newFolderName.trim()
    if (!name || !current) return
    setBusy(true)
    setInlineError(null)
    void (async () => {
      const plan = await window.electronAPI.planCoreProject({ basePath: current.path, projectName: name })
      if (plan.target.exists) throw new Error('这个名称已经存在')
      await window.electronAPI.createCoreDirectory({ path: plan.targetPath })
      setCreatingFolder(false)
      setNewFolderName('新建文件夹')
      setReloadKey(key => key + 1)
      toast.success('已新建文件夹')
    })().catch((err) => {
      setInlineError(errorText(err))
    }).finally(() => setBusy(false))
  }

  const goUp = (): void => {
    if (atComputer) return
    if (current?.parent) void openPath(current.parent)
    else setAtComputer(true)
  }

  const segments = React.useMemo(() => segmentsOf(current?.path ?? ''), [current?.path])

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-1.5 px-2 pb-2 pt-1">
      {/* 地址栏：上一级 / 面包屑（点空白变输入）/ 粘贴 / 新建文件夹 */}
      <div className="flex items-center gap-1 rounded-lg border border-border/60 px-1 py-1">
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" disabled={loading || atComputer} title="上一级" onClick={goUp}>
          <ChevronLeft className="size-3.5" />
        </Button>
        {editingPath ? (
          <input
            ref={pathInputRef}
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); setEditingPath(false); return }
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              const next = pathDraft.trim()
              if (!next) { setAtComputer(true); setEditingPath(false); return }
              void openPath(next)
            }}
            spellCheck={false}
            aria-label="系统路径"
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary/60"
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            className="flex min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded px-1 py-0.5 hover:bg-foreground/[0.04]"
            title="点击输入路径"
            onClick={() => { setPathDraft(atComputer ? '' : (current?.path ?? '')); setEditingPath(true) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { setPathDraft(atComputer ? '' : (current?.path ?? '')); setEditingPath(true) } }}
          >
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              onClick={(event) => { event.stopPropagation(); setAtComputer(true); setEditingPath(false) }}
              title="此电脑"
            >
              <Monitor className="size-3.5" />此电脑
            </button>
            {!atComputer && segments.map(segment => (
              <React.Fragment key={segment.path}>
                <span className="text-muted-foreground/40">/</span>
                <button
                  type="button"
                  className="max-w-[150px] truncate rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  onClick={(event) => { event.stopPropagation(); void openPath(segment.path) }}
                  title={segment.path}
                >
                  {segment.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" disabled={!clipboard || !current || busy} onClick={paste} aria-label="粘贴">
              <Copy className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>{clipboard ? `粘贴「${clipboard.name}」` : '粘贴'}</p></TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" disabled={atComputer || !current || busy} onClick={() => { setCreatingFolder(true); setNewFolderName('新建文件夹') }} aria-label="新建文件夹">
              <FolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>新建文件夹</p></TooltipContent>
        </Tooltip>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" disabled={loading || atComputer} onClick={() => current && void openPath(current.path)} title="刷新">
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      </div>

      {clipboard && (
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-foreground/[0.03] px-2 py-1 text-[11px] text-muted-foreground">
          <Copy className="size-3" />
          <span className="truncate">{clipboard.mode === 'cut' ? '已剪切：' : '已复制：'}{clipboard.name}</span>
          <button type="button" className="ml-auto rounded px-1 hover:text-foreground" onClick={() => setClipboard(null)}>取消</button>
        </div>
      )}

      {creatingFolder && (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5">
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setCreatingFolder(false); return }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); createFolder() }
            }}
            maxLength={120}
            aria-label="新文件夹名称"
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary/60"
          />
          <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={createFolder}>创建</Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setCreatingFolder(false)}>取消</Button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {loading && !current && !atComputer ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在读取目录…</div>
        ) : error ? (
          <div className="px-3 py-4 text-xs text-destructive">{error}</div>
        ) : atComputer ? (
          <div className="p-1">
            {overview?.roots.map(root => (
              <button key={root.path} type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/60" onClick={() => void openPath(root.path)} title={root.path}>
                <HardDrive className="size-4 shrink-0 text-foreground/50" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{root.label}</span>
                <span className="truncate text-[11px] text-muted-foreground">{root.path}</span>
              </button>
            ))}
            {overview && (
              <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/60" onClick={() => void openPath(overview.home)} title={overview.home}>
                <Home className="size-4 shrink-0 text-foreground/50" />
                <span className="min-w-0 flex-1 truncate text-[13px]">主目录</span>
                <span className="truncate text-[11px] text-muted-foreground">{overview.home}</span>
              </button>
            )}
          </div>
        ) : current ? (
          <FileBrowser
            key={reloadKey}
            rootPath={current.path}
            hideToolbar
            embedded
            loadDirectory={loadDirectory}
            fileOps={fileOps}
            onCopy={(entry) => setClipboard({ mode: 'copy', path: entry.path, name: entry.name })}
            onCut={(entry) => setClipboard({ mode: 'cut', path: entry.path, name: entry.name })}
          />
        ) : null}
      </div>

      {inlineError && <p className="px-1 text-[11px] text-destructive">{inlineError}</p>}
      <p className="px-1 text-[10px] text-muted-foreground/70">这是目标机器上的真实文件；删除会进 Core 回收站。</p>
    </div>
  )
}
