/**
 * CoreFolderBrowser — 浏览“所属 Core”的文件系统并新建/打开项目。
 *
 * 交互（2026-11-17 与用户确认）：
 * - 顶部一行：上一级 / 地址栏（面包屑，点空白处变成输入框）/ 新建文件夹图标按钮；
 * - “此电脑”视图列盘符与主目录，不再单独占一行；
 * - 新建项目时项目名称必填，最终项目根 = 选中目录 / 项目名称；
 * - 创建前逐步确认：父路径缺失（说明要建几个文件夹）→ 项目文件夹不存在 → 同名空目录 → 同名非空（询问口吻）；
 * - 任何确认取消都回到面板，保留名称与路径。
 */

import * as React from 'react'
import { ChevronLeft, Folder, FolderPlus, HardDrive, Home, LoaderCircle, Monitor, RefreshCw } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { ScrollArea } from '@profer/ui/primitives/scroll-area'
import type { CoreDirectoryListing, CoreFsOverview, CoreProjectPlan } from '@profer/shared'

export interface CoreFolderBrowserProps {
  initialPath?: string
  /** true：新建项目（要填名称）；false：打开已有项目（选中的目录就是项目根）。 */
  requireName?: boolean
  confirmLabel?: string
  onSelect: (path: string, name?: string) => void
  onCancel: () => void
}

type ConfirmKind = 'missing-base' | 'create-target' | 'reuse-empty' | 'reuse-nonempty'

function splitPathSegments(value: string): Array<{ label: string; path: string }> {
  const separator = value.includes('\\') ? '\\' : '/'
  const parts = value.split(/[\\/]+/).filter(Boolean)
  const segments: Array<{ label: string; path: string }> = []
  let accumulated = ''
  for (const part of parts) {
    if (!accumulated) accumulated = value.startsWith('/') || value.startsWith('\\') ? `${separator}${part}` : part
    else accumulated = `${accumulated.replace(/[\\/]+$/, '')}${separator}${part}`
    segments.push({ label: part, path: accumulated })
  }
  return segments
}

/** Windows 盘符单独一段时补上根分隔符，否则 Core 会拒绝“必须是绝对路径”。 */
function normalizeNavigablePath(value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`
  return trimmed
}

function platformLabel(platform: string | undefined): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return 'Core'
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim() || '操作失败'
}

/** 项目名称校验：单段目录名。用字符码判断分隔符，避免源码里出现转义字符。 */
function validateProjectName(value: string): string | null {
  const name = value.trim()
  if (!name) return '请填写项目名称'
  if (name === '.' || name === '..') return '项目名称不能是 . 或 ..'
  if (name.length > 120) return '项目名称过长'
  const forbidden = ['/', String.fromCharCode(92), String.fromCharCode(0)]
  if (forbidden.some(token => name.includes(token))) return '项目名称不能包含路径分隔符'
  return null
}

export function CoreFolderBrowser({ initialPath, requireName = false, confirmLabel, onSelect, onCancel }: CoreFolderBrowserProps): React.ReactElement {
  const [overview, setOverview] = React.useState<CoreFsOverview | null>(null)
  const [listing, setListing] = React.useState<CoreDirectoryListing | null>(null)
  const [atComputer, setAtComputer] = React.useState(false)
  const [editingPath, setEditingPath] = React.useState(false)
  const [pathDraft, setPathDraft] = React.useState('')
  const [projectName, setProjectName] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [listError, setListError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [plan, setPlan] = React.useState<CoreProjectPlan | null>(null)
  const [confirmKind, setConfirmKind] = React.useState<ConfirmKind | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [creatingFolder, setCreatingFolder] = React.useState(false)
  const [newFolderName, setNewFolderName] = React.useState('新建文件夹')
  const [newFolderError, setNewFolderError] = React.useState<string | null>(null)
  const pathInputRef = React.useRef<HTMLInputElement>(null)
  const newFolderInputRef = React.useRef<HTMLInputElement>(null)

  const openPath = React.useCallback(async (rawPath: string): Promise<void> => {
    const path = normalizeNavigablePath(rawPath)
    if (!path) return
    setLoading(true)
    setListError(null)
    setActionError(null)
    try {
      const result = await window.electronAPI.listCoreDirectories(path)
      setListing(result)
      setAtComputer(false)
      setEditingPath(false)
    } catch (err) {
      setListError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await window.electronAPI.getCoreFileSystemOverview()
        if (cancelled) return
        setOverview(info)
        const start = initialPath?.trim()
        if (start) await openPath(start)
        else setAtComputer(true)
      } catch (err) {
        if (!cancelled) setListError(errorText(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [initialPath, openPath])

  React.useEffect(() => {
    if (editingPath) requestAnimationFrame(() => pathInputRef.current?.select())
  }, [editingPath])
  React.useEffect(() => {
    if (creatingFolder) requestAnimationFrame(() => newFolderInputRef.current?.select())
  }, [creatingFolder])

  const segments = React.useMemo(() => splitPathSegments(listing?.path ?? ''), [listing?.path])
  const currentBase = atComputer ? '' : (listing?.path ?? '')
  const nameError = requireName ? validateProjectName(projectName) : null
  const previewTarget = React.useMemo(() => {
    if (!currentBase) return ''
    if (!requireName) return currentBase
    const name = projectName.trim()
    if (!name) return currentBase
    const separator = currentBase.includes('\\') ? '\\' : '/'
    return `${currentBase.replace(/[\\/]+$/, '')}${separator}${name}`
  }, [currentBase, projectName, requireName])

  const goUp = (): void => {
    if (atComputer) return
    if (listing?.parent) void openPath(listing.parent)
    else setAtComputer(true)
  }

  /** 新建文件夹：用 Core 的规划接口算目标路径与同名冲突，不在渲染层拼路径。 */
  const createFolder = async (): Promise<void> => {
    if (!currentBase || busy) return
    const name = newFolderName.trim()
    if (!name) { setNewFolderError('请填写文件夹名称'); return }
    setBusy(true)
    setNewFolderError(null)
    try {
      const next = await window.electronAPI.planCoreProject({ basePath: currentBase, projectName: name })
      if (next.target.exists) { setNewFolderError('这个名称已经存在'); return }
      await window.electronAPI.createCoreDirectory({ path: next.targetPath })
      setCreatingFolder(false)
      setNewFolderName('新建文件夹')
      await openPath(next.targetPath)
    } catch (err) {
      setNewFolderError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  /** 确认步骤：父路径缺失 → 项目文件夹不存在 → 同名空目录 → 同名非空目录。 */
  const decide = (next: CoreProjectPlan): void => {
    if (!next.baseExists) { setConfirmKind('missing-base'); return }
    if (!next.baseIsDirectory) { setActionError('这个路径已经存在，但不是文件夹，不能作为项目位置。'); return }
    if (next.target.exists && !next.target.isDirectory) { setActionError('同名路径已经存在，但不是文件夹。'); return }
    if (!next.target.exists) { setConfirmKind('create-target'); return }
    setConfirmKind(next.target.empty ? 'reuse-empty' : 'reuse-nonempty')
  }

  /** 按平台语义由 Core 规划：父路径缺几段、目标文件夹是否存在/为空。 */
  const requestPlan = async (): Promise<void> => {
    if (!currentBase || busy) return
    if (nameError) { setActionError(nameError); return }
    setBusy(true)
    setActionError(null)
    try {
      const next = await window.electronAPI.planCoreProject({
        basePath: currentBase,
        ...(requireName ? { projectName: projectName.trim() } : {}),
      })
      setPlan(next)
      decide(next)
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmMissingBase = async (): Promise<void> => {
    if (!plan || busy) return
    setBusy(true)
    setActionError(null)
    try {
      await window.electronAPI.createCoreDirectory({ path: plan.basePath })
      setConfirmKind(null)
      if (!requireName) { onSelect(plan.basePath); return }
      const next = await window.electronAPI.planCoreProject({ basePath: plan.basePath, projectName: projectName.trim() })
      setPlan(next)
      await openPath(next.basePath)
      decide(next)
    } catch (err) {
      setActionError(errorText(err))
      setConfirmKind(null)
    } finally {
      setBusy(false)
    }
  }

  const confirmCreateTarget = async (): Promise<void> => {
    if (!plan || busy) return
    setBusy(true)
    setActionError(null)
    try {
      await window.electronAPI.createCoreDirectory({ path: plan.targetPath })
      setConfirmKind(null)
      onSelect(plan.targetPath, requireName ? projectName.trim() : undefined)
    } catch (err) {
      setActionError(errorText(err))
      setConfirmKind(null)
    } finally {
      setBusy(false)
    }
  }

  const missingCount = plan?.baseMissingSegments.length ?? 0
  const confirmTitle = confirmKind === 'missing-base' ? '这个路径还不存在'
    : confirmKind === 'create-target' ? '当前目录下没有这个项目文件夹'
      : confirmKind === 'reuse-empty' ? '已存在同名空文件夹'
        : '这个文件夹不是空的'

  return (
    <div className="relative flex flex-col gap-2" data-testid="core-folder-browser">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <HardDrive className="size-3.5 shrink-0" />
          <span className="truncate">正在浏览所属 Core 的文件系统（{platformLabel(overview?.platform)}）</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => listing && void openPath(listing.path)}
          disabled={loading || atComputer}
          title="刷新"
        >
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      </div>

      {/* 地址栏行：上一级 / 面包屑（点空白处变输入）/ 新建文件夹 */}
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
              if (event.key !== 'Enter') return
              if (event.nativeEvent.isComposing) return
              event.preventDefault()
              const next = pathDraft.trim()
              if (!next) { setAtComputer(true); setEditingPath(false); return }
              void openPath(next)
            }}
            spellCheck={false}
            aria-label="路径"
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary/60"
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            className="flex min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded px-1 py-0.5 hover:bg-foreground/[0.04]"
            title="点击输入路径"
            onClick={() => { setPathDraft(atComputer ? '' : currentBase); setEditingPath(true) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { setPathDraft(atComputer ? '' : currentBase); setEditingPath(true) } }}
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
                  className="max-w-[160px] truncate rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              disabled={loading || atComputer || !currentBase}
              onClick={() => { setCreatingFolder(true); setNewFolderError(null); setNewFolderName('新建文件夹') }}
              aria-label="新建文件夹"
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>新建文件夹</p></TooltipContent>
        </Tooltip>
      </div>

      {creatingFolder && (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5">
          <input
            ref={newFolderInputRef}
            value={newFolderName}
            onChange={(event) => { setNewFolderName(event.target.value); setNewFolderError(null) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setCreatingFolder(false); return }
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              void createFolder()
            }}
            maxLength={120}
            aria-label="新文件夹名称"
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary/60"
          />
          <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void createFolder()}>
            {busy ? <LoaderCircle className="size-3 animate-spin" /> : '创建'}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => setCreatingFolder(false)}>取消</Button>
          {newFolderError && <span className="text-[11px] text-destructive">{newFolderError}</span>}
        </div>
      )}

      <div className="h-[236px] rounded-lg border border-border/60">
        <ScrollArea className="h-full">
          <div className="p-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />正在读取目录…
              </div>
            )}
            {!loading && listError && (
              <div className="space-y-1 px-3 py-4 text-xs">
                <p className="text-destructive">{listError}</p>
                <p className="text-muted-foreground">路径不存在也可以继续：点右下角按钮会先询问是否新建。</p>
              </div>
            )}

            {!loading && !listError && atComputer && (
              <>
                {overview?.roots.map(root => (
                  <button
                    key={root.path}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/60"
                    onClick={() => void openPath(root.path)}
                    title={root.path}
                  >
                    <HardDrive className="size-4 shrink-0 text-foreground/50" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{root.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{root.path}</span>
                  </button>
                ))}
                {overview && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/60"
                    onClick={() => void openPath(overview.home)}
                    title={overview.home}
                  >
                    <Home className="size-4 shrink-0 text-foreground/50" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">主目录</span>
                    <span className="truncate text-[11px] text-muted-foreground">{overview.home}</span>
                  </button>
                )}
              </>
            )}

            {!loading && !listError && !atComputer && listing?.entries.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">这个目录下没有子文件夹</div>
            )}
            {!loading && !listError && !atComputer && listing?.entries.map(entry => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/60"
                onClick={() => void openPath(entry.path)}
                title={entry.path}
              >
                <Folder className="size-4 shrink-0 text-foreground/50" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {requireName && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
            <span>项目名称</span><span>必填，只能是单层文件夹名</span>
          </div>
          <input
            value={projectName}
            onChange={(event) => { setProjectName(event.target.value); setActionError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void requestPlan() } }}
            placeholder="例如 my-app"
            maxLength={120}
            aria-label="项目名称"
            className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/60"
          />
        </div>
      )}

      {previewTarget && !atComputer && (
        <p className="break-all text-[11px] text-muted-foreground">
          {requireName ? '最终项目根：' : '将打开：'}<span className="text-foreground/80">{previewTarget}</span>
        </p>
      )}
      {actionError && <p className="text-[11px] text-destructive">{actionError}</p>}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button
          type="button"
          size="sm"
          disabled={!currentBase || busy || loading || atComputer || Boolean(nameError)}
          onClick={() => void requestPlan()}
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : confirmLabel ?? (requireName ? '创建项目' : '打开此文件夹')}
        </Button>
      </div>

      {confirmKind && plan && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-background/70 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-[440px] rounded-xl border border-border/70 bg-card p-4 shadow-2xl">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className={confirmKind === 'reuse-nonempty' ? 'size-2 rounded-full bg-amber-500' : 'size-2 rounded-full bg-primary'} />
              {confirmTitle}
            </div>
            <div className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
              {confirmKind === 'missing-base' && (
                <>
                  <p>从最近存在的上级到这个路径，需要新建 <span className="text-foreground/80">{missingCount}</span> 个文件夹：</p>
                  <p className="break-all text-foreground/80">{plan.baseMissingSegments.join('、')}</p>
                  {requireName && <p>建好后会再确认项目文件夹「{projectName.trim()}」的创建方式。</p>}
                </>
              )}
              {confirmKind === 'create-target' && (
                <>
                  <p>当前目录下没有「{projectName.trim()}」，会新建文件夹并在这里创建工程：</p>
                  <p className="break-all text-foreground/80">{plan.targetPath}</p>
                </>
              )}
              {confirmKind === 'reuse-empty' && (
                <>
                  <p>「{projectName.trim()}」这个文件夹已经存在，而且是空的。</p>
                  <p>将直接在这个文件夹下创建工程（生成 <code className="rounded bg-foreground/10 px-1">.profer</code> 配置）。</p>
                </>
              )}
              {confirmKind === 'reuse-nonempty' && (
                <>
                  <p>「{projectName.trim()}」这个文件夹不是空的，里面有 {plan.target.entryCount} 项内容。</p>
                  <p>要在这个文件夹里创建工程吗？会在其中生成 <code className="rounded bg-foreground/10 px-1">.profer</code>，不会删除或移动现有文件。</p>
                  {plan.target.hasProfer && plan.targetPath !== overview?.home && (
                    <p className="text-amber-500">它看起来已经是一个 Profer 项目，也可以取消后改用「打开已有项目」。</p>
                  )}
                </>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmKind(null)}>取消</Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (confirmKind === 'missing-base') void confirmMissingBase()
                  else if (confirmKind === 'create-target') void confirmCreateTarget()
                  else onSelect(plan.targetPath, requireName ? projectName.trim() : undefined)
                }}
              >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" />
                  : confirmKind === 'missing-base' ? '新建并继续'
                    : confirmKind === 'create-target' ? '新建并创建工程'
                      : confirmKind === 'reuse-empty' ? '在这里创建'
                        : '在这个文件夹里创建'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
