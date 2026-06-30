/**
 * FileBrowser — 通用文件浏览器面板
 *
 * 显示指定根路径下的文件树，支持：
 * - 文件夹懒加载展开（Chevron 旋转动画）
 * - 单击选中、Cmd/Ctrl+Click 多选
 * - 悬浮/选中后显示三点菜单（添加到聊天 / 在文件夹中显示 / 重命名 / 移动 / 删除）
 * - 文件/文件夹删除（带确认对话框）
 * - 原位重命名（含同名检查）
 * - 自动刷新
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  ChevronRight,
  Trash2,
  RefreshCw,
  ExternalLink,
  FolderSearch,
  MoreHorizontal,
  FolderInput,
  Pencil,
  MessageSquarePlus,
  Upload,
  Download,
  Eye,
  LayoutList,
  LayoutGrid,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { workspaceFilesVersionAtom, fileBrowserAutoRevealAtom, recentlyModifiedPathsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import type { FileEntry } from '@proma/shared'
import { FileTypeIcon } from './FileTypeIcon'
import { DefaultAppMenuItem } from './DefaultAppMenuItem'
import {
  computeTreeRowLayout,
  AncestorGuides,
  STICKY_ROW_BASE_CLASS,
  canBeSticky,
} from './tree-row-layout'

/** 计算目标路径相对 rootPath 的祖先目录集合（不含 rootPath 自身、含目标的所有上级） */
export function computeRevealAncestors(rootPath: string, targetPath: string): Set<string> {
  const ancestors = new Set<string>()
  if (!rootPath || !targetPath) return ancestors
  // 归一化：移除尾部分隔符
  const root = rootPath.replace(/[/\\]+$/, '')
  if (targetPath === root) return ancestors
  const sep = targetPath.includes('\\') ? '\\' : '/'
  if (!targetPath.startsWith(root + sep)) return ancestors
  // 取相对 root 的部分，逐级累加
  const relative = targetPath.slice(root.length + sep.length)
  const parts = relative.split(/[/\\]/).filter(Boolean)
  // 文件本身不算祖先，只到父目录
  let current = root
  for (let i = 0; i < parts.length - 1; i++) {
    current = current + sep + parts[i]
    ancestors.add(current)
  }
  return ancestors
}

/** 判断目标路径是否落在 rootPath 内 */
export function isPathUnderRoot(rootPath: string, targetPath: string): boolean {
  if (!rootPath || !targetPath) return false
  const root = rootPath.replace(/[/\\]+$/, '')
  if (targetPath === root) return true
  return targetPath.startsWith(root + '/') || targetPath.startsWith(root + '\\')
}

interface FileBrowserProps {
  rootPath: string
  hideToolbar?: boolean
  embedded?: boolean
  hideEmpty?: boolean
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  /** 团队工作区 ID（有值时启用团队网盘模式，从服务器拉清单） */
  workspaceId?: string
  workspaceSlug?: string
}

/**
 * 将扁平的文件清单构建为树状结构
 *
 * 服务端返回扁平的 FileEntry[]，通过 path 字段（如 "a/b/c.txt"）推断层级。
 * 文件夹节点自动聚合子节点到 children 数组。
 */
function buildFileTree(flatEntries: FileEntry[]): FileEntry[] {
  const root: FileEntry[] = []
  const dirMap = new Map<string, FileEntry>()

  // 按路径深度排序，确保父目录先于子文件
  const sorted = [...flatEntries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)

  for (const entry of sorted) {
    const parts = entry.path.split('/')
    if (parts.length === 1) {
      // 根级条目
      root.push({ ...entry, children: (entry.isDirectory ? [] : undefined) })
      if (entry.isDirectory) dirMap.set(entry.path, root[root.length - 1]!)
    } else {
      // 有父目录的子条目
      const parentPath = parts.slice(0, -1).join('/')
      const parent = dirMap.get(parentPath)
      if (parent?.children) {
        const node: FileEntry = { ...entry, children: (entry.isDirectory ? [] : undefined) }
        parent.children.push(node)
        if (entry.isDirectory) dirMap.set(entry.path, node)
      } else {
        // 父目录不在清单中（异常情况），放到根级
        root.push({ ...entry, children: (entry.isDirectory ? [] : undefined) })
        if (entry.isDirectory) dirMap.set(entry.path, root[root.length - 1]!)
      }
    }
  }

  // 排序：目录在前，文件在后，同类按名称排序
  const sortEntries = (items: FileEntry[]) => {
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const item of items) {
      if (item.children) sortEntries(item.children)
    }
  }
  sortEntries(root)
  return root
}

export function FileBrowser({ rootPath, hideToolbar, embedded, hideEmpty, onAddToChat, onFilePreview, workspaceId, workspaceSlug }: FileBrowserProps): React.ReactElement {
  const [entries, setEntries] = React.useState<FileEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<'list' | 'grid'>('list')
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)

  // ===== Agent 写入文件时的自动定位 =====
  const autoReveal = useAtomValue(fileBrowserAutoRevealAtom)
  // 仅当目标路径落在本实例 rootPath 内才响应；以 ts 标识本次脉冲
  const revealForThisRoot = React.useMemo(() => {
    if (!autoReveal || !rootPath) return null
    if (!isPathUnderRoot(rootPath, autoReveal.path)) return null
    return autoReveal
  }, [autoReveal, rootPath])
  const revealAncestors = React.useMemo(
    () => revealForThisRoot ? computeRevealAncestors(rootPath, revealForThisRoot.path) : new Set<string>(),
    [revealForThisRoot, rootPath],
  )
  const revealTarget = revealForThisRoot?.path ?? null
  const revealTs = revealForThisRoot?.ts ?? 0
  const revealSelect = revealForThisRoot?.select ?? false

  // ===== autoReveal 带 select 标记时，将目标文件加入选中态 =====
  const consumedSelectTsRef = React.useRef(0)
  React.useEffect(() => {
    if (!revealForThisRoot?.select || !revealTarget) return
    // 避免同一个 ts 被重复消费
    if (revealTs <= consumedSelectTsRef.current) return
    consumedSelectTsRef.current = revealTs
    setSelectedPaths(new Set([revealTarget]))
  }, [revealTs, revealForThisRoot?.select, revealTarget])

  // ===== 最近修改的文件路径（60s 内显示左侧竖条） =====
  const recentlyModifiedMap = useAtomValue(recentlyModifiedPathsAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const recentlyModifiedSet = React.useMemo<Set<string>>(() => {
    if (!currentSessionId) return new Set()
    const inner = recentlyModifiedMap.get(currentSessionId)
    if (!inner) return new Set()
    // 仅保留落在本实例 rootPath 下的路径
    const set = new Set<string>()
    for (const p of inner.keys()) {
      if (isPathUnderRoot(rootPath, p)) set.add(p)
    }
    return set
  }, [recentlyModifiedMap, currentSessionId, rootPath])

  // 选中状态
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set())
  // 删除确认状态
  const [deleteTarget, setDeleteTarget] = React.useState<FileEntry | null>(null)
  const [deleteCount, setDeleteCount] = React.useState(1)
  // 重命名状态
  const [renamingPath, setRenamingPath] = React.useState<string | null>(null)
  // 移动中状态
  const [moving, setMoving] = React.useState(false)

  const selectedCount = selectedPaths.size

  /** 加载根目录 */
  const isTeamMode = !!(workspaceId && workspaceSlug)

  const loadRoot = React.useCallback(async () => {
    if (!rootPath) return
    setLoading(true)
    setError(null)
    try {
      if (isTeamMode) {
        const manifest = await window.electronAPI.teamFile.getManifest(workspaceId!, workspaceSlug).catch(() => null)
        // null = 拉取失败（认证/网络）→ 保留当前列表，避免 token 失效误清空文件
        if (manifest === null) return
        const serverItems: FileEntry[] = manifest.map((f: { name: string; path: string; isDirectory: boolean; size: number; syncStatus?: FileEntry['syncStatus']; localExists?: boolean; uploadedBy?: string; uploadedByName?: string }) => ({
          name: f.name, path: f.path, isDirectory: f.isDirectory, size: f.size,
          syncStatus: f.syncStatus ?? (f.localExists ? 'synced' : 'cloud-only'),
          uploadedBy: f.uploadedBy ?? '',
          uploadedByName: f.uploadedByName ?? '',
        }))
        // 构建树状结构：目录可折叠展开
        const tree = buildFileTree(serverItems)
        setEntries(tree)
      } else {
        const items = await window.electronAPI.listDirectory(rootPath)
        setEntries(items)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      setError(msg)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [rootPath, isTeamMode, workspaceId, workspaceSlug])

  /** 处理文件上传（拖拽或按钮触发） */
  const handleFileUpload = React.useCallback(async (files: File[]) => {
    setUploading(true)
    let count = 0
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer()
        if (isTeamMode) {
          // 团队模式：上传到服务器
          const data = new Uint8Array(buffer)
          let sourcePath = ''
          try {
            sourcePath = window.electronAPI.getPathForFile(file)
          } catch {
            sourcePath = ''
          }
          await window.electronAPI.teamFile.upload({
            workspaceId: workspaceId!,
            workspaceSlug: workspaceSlug!,
            fileName: file.name,
            fileData: data,
            sourcePath: sourcePath || undefined,
          })
        } else {
          // 个人模式：保存到本地工作区
          await window.electronAPI.saveFilesToWorkspaceFiles({
            workspaceSlug: workspaceSlug || 'default',
            files: [{ filename: file.name, data: new Uint8Array(buffer) }],
          })
        }
        count++
      } catch (err) {
        console.error('文件上传失败:', file.name, err)
      }
    }
    setUploading(false)
    if (count > 0) loadRoot()
  }, [isTeamMode, workspaceId, workspaceSlug, loadRoot])

  /** 网格视图删除文件 */
  const handleDeleteGrid = React.useCallback(async (entry: FileEntry) => {
    if (isTeamMode && workspaceId && workspaceSlug) {
      const ok = await window.electronAPI.teamFile.delete({
        workspaceId, workspaceSlug, filePath: entry.path,
      }).catch(() => false)
      if (ok) {
        // 同步删除本地文件/文件夹
        const localPath = `${rootPath}/${entry.path}`
        window.electronAPI.deleteFile(localPath).catch(() => {})
        loadRoot()
      }
    }
  }, [isTeamMode, workspaceId, workspaceSlug, rootPath, loadRoot])

  /** 下载云端文件到本地 */
  const handleDownload = React.useCallback(async (entry: FileEntry): Promise<string | null> => {
    if (!isTeamMode || !workspaceId || !workspaceSlug) return null
    const local = await window.electronAPI.teamFile.download({ workspaceId, workspaceSlug, filePath: entry.path, uploadedBy: entry.uploadedBy })
    if (local) loadRoot()
    return local
  }, [isTeamMode, workspaceId, workspaceSlug, loadRoot])

  /** 团队文件预览前必须先落到本地缓存，Office/PDF 等预览器只能读取本地文件。 */
  const ensureTeamFileLocal = React.useCallback(async (entry: FileEntry): Promise<string | null> => {
    if (!isTeamMode || !workspaceId || !workspaceSlug) return null
    const local = await window.electronAPI.teamFile.download({ workspaceId, workspaceSlug, filePath: entry.path, uploadedBy: entry.uploadedBy })
    if (local && entry.syncStatus === 'cloud-only') void loadRoot()
    return local
  }, [isTeamMode, workspaceId, workspaceSlug, loadRoot])

  const handlePreviewFile = React.useCallback(async (entry: FileEntry): Promise<void> => {
    if (entry.isDirectory) return
    if (isTeamMode) {
      const local = await ensureTeamFileLocal(entry)
      if (local) {
        onFilePreview?.(local)
      } else {
        window.dispatchEvent(new CustomEvent('proma:file-preview', {
          detail: { path: entry.path, name: entry.name, download: () => ensureTeamFileLocal(entry) },
        }))
      }
      return
    }

    onFilePreview?.(entry.path)
  }, [ensureTeamFileLocal, isTeamMode, onFilePreview])

  const dispatchInlinePreview = React.useCallback((entry: FileEntry): void => {
    if (entry.isDirectory) return
    window.dispatchEvent(new CustomEvent('proma:file-preview', {
      detail: {
        path: isTeamMode ? entry.path : entry.path,
        name: entry.name,
        download: isTeamMode ? () => ensureTeamFileLocal(entry) : undefined,
      },
    }))
  }, [ensureTeamFileLocal, isTeamMode])

  /** 拖拽事件 */
  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(true)
  }, [])
  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
  }, [])
  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0) handleFileUpload(Array.from(files))
  }, [handleFileUpload])

  React.useEffect(() => {
    loadRoot()
  }, [loadRoot, filesVersion])

  /** 选中项 */
  const handleSelect = React.useCallback((entry: FileEntry, event: React.MouseEvent) => {
    const isMulti = event.metaKey || event.ctrlKey
    if (isMulti) {
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(entry.path)) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
        }
        return next
      })
    } else {
      setSelectedPaths(new Set([entry.path]))
      // 单击非目录文件 → 预览
      if (!entry.isDirectory) {
        dispatchInlinePreview(entry)
      }
    }
  }, [dispatchInlinePreview])

  /** 点击空白区域清空选中 */
  const handleBackgroundClick = React.useCallback((e: React.MouseEvent) => {
    // 只处理直接点击容器的情况
    if (e.target === e.currentTarget) {
      setSelectedPaths(new Set())
    }
  }, [])

  /** 在文件夹中显示 */
  const handleShowInFolder = React.useCallback(async (entry: FileEntry) => {
    if (isTeamMode) {
      if (!entry.isDirectory && workspaceId && workspaceSlug) {
        const local = await window.electronAPI.teamFile.download({ workspaceId, workspaceSlug, filePath: entry.path, uploadedBy: entry.uploadedBy })
        if (local) {
          window.electronAPI.showItemInFolder(local).catch(console.error)
          await loadRoot()
        }
        return
      }
      const localPath = `${rootPath}/${entry.path}`
      window.electronAPI.showItemInFolder(localPath).catch(console.error)
      return
    }
    window.electronAPI.showInFolder(entry.path).catch(console.error)
  }, [isTeamMode, loadRoot, rootPath, workspaceId, workspaceSlug])

  /** 开始重命名 */
  const handleStartRename = React.useCallback((entry: FileEntry) => {
    setRenamingPath(entry.path)
  }, [])

  /** 取消重命名 */
  const handleCancelRename = React.useCallback(() => {
    setRenamingPath(null)
  }, [])

  /** 执行重命名 */
  const handleRename = React.useCallback(async (filePath: string, newName: string): Promise<string | null> => {
    // 同名检查
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'))
    try {
      if (isTeamMode) return '团队文件暂不支持在侧栏重命名'
      const siblings = await window.electronAPI.listDirectory(parentDir)
      const conflict = siblings.some((s) => s.name === newName && s.path !== filePath)
      if (conflict) {
        return '同名文件已存在'
      }
    } catch {
      // 无法列出目录，跳过检查
    }

    try {
      await window.electronAPI.renameFile(filePath, newName)
      await loadRoot()
      setRenamingPath(null)
      setSelectedPaths(new Set())
      return null
    } catch (err) {
      return err instanceof Error ? err.message : '重命名失败'
    }
  }, [isTeamMode, loadRoot])

  /** 触发删除（支持多选） */
  const handleRequestDelete = React.useCallback((entry: FileEntry) => {
    setDeleteTarget(entry)
    setDeleteCount(selectedCount > 1 ? selectedCount : 1)
  }, [selectedCount])

  /** 执行删除 */
  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    try {
      const paths = selectedPaths.size > 1 ? [...selectedPaths] : [deleteTarget.path]
      for (const filePath of paths) {
        if (isTeamMode && workspaceId && workspaceSlug) {
          const ok = await window.electronAPI.teamFile.delete({ workspaceId, workspaceSlug, filePath }).catch(() => false)
          if (ok) {
            // 同步删除本地文件/文件夹
            window.electronAPI.deleteFile(`${rootPath}/${filePath}`).catch(() => {})
          }
        } else {
          await window.electronAPI.deleteFile(filePath)
        }
      }
      setSelectedPaths(new Set())
      await loadRoot()
    } catch (err) {
      console.error('[FileBrowser] 删除失败:', err)
    }
    setDeleteTarget(null)
  }, [deleteTarget, selectedPaths, loadRoot, isTeamMode, workspaceId, workspaceSlug])

  /** 移动文件 */
  const handleMove = React.useCallback(async (entry: FileEntry) => {
    setMoving(true)
    try {
      const result = await window.electronAPI.openFolderDialog()
      if (!result) return

      if (isTeamMode) return
      if (selectedPaths.size > 1) {
        for (const path of selectedPaths) {
          await window.electronAPI.moveFile(path, result.path)
        }
      } else {
        await window.electronAPI.moveFile(entry.path, result.path)
      }
      setSelectedPaths(new Set())
      await loadRoot()
    } catch (err) {
      console.error('[FileBrowser] 移动失败:', err)
    } finally {
      setMoving(false)
    }
  }, [isTeamMode, selectedPaths, loadRoot])

  // 显示根路径最后两段作为面包屑
  const breadcrumb = React.useMemo(() => {
    const parts = rootPath.split('/').filter(Boolean)
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : rootPath
  }, [rootPath])

  const fileTree = (
    <div className="py-1" onClick={handleBackgroundClick}>
      {error && (
        <div className="px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      {!error && entries.length === 0 && !loading && !hideEmpty && (
        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
          目录为空
        </div>
      )}
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.path}
          entry={entry}
          depth={0}
          selectedPaths={selectedPaths}
          selectedCount={selectedCount}
          renamingPath={renamingPath}
          moving={moving}
          refreshVersion={filesVersion}
          revealAncestors={revealAncestors}
          revealTarget={revealTarget}
          revealTs={revealTs}
          revealSelect={revealSelect}
          recentlyModifiedSet={recentlyModifiedSet}
          onSelect={handleSelect}
          onShowInFolder={handleShowInFolder}
          onStartRename={handleStartRename}
          onCancelRename={handleCancelRename}
          onRename={handleRename}
          onDelete={handleRequestDelete}
          onMove={handleMove}
          onRefresh={loadRoot}
          onClearSelection={() => setSelectedPaths(new Set())}
          onAddToChat={onAddToChat}
          onFilePreview={handlePreviewFile}
          onDownload={handleDownload}
        />
      ))}
    </div>
  )

  return (
    <div
      className={cn('relative flex flex-col', !embedded && 'h-full', dragOver && 'ring-2 ring-primary/50')}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 顶部工具栏（可由外部接管） */}
      {!hideToolbar && (
        <div className="flex items-center gap-1 px-3 pr-10 h-[48px] border-b flex-shrink-0">
          <span className="text-xs text-muted-foreground truncate flex-1" title={rootPath}>
            {breadcrumb}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={() => window.electronAPI.openFile(rootPath).catch(console.error)}
            title="在 Finder 中打开"
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={loadRoot}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
          {/* 上传按钮 */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={() => fileInputRef.current?.click()}
            title="上传文件"
          >
            <Upload className="size-3.5" />
          </Button>
          {uploading && <span className="text-[10px] text-muted-foreground">上传中...</span>}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files
              if (files) handleFileUpload(Array.from(files))
              e.target.value = ''
            }}
          />
          {/* 视图切换 */}
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0"
            onClick={() => setViewMode(viewMode === 'list' ? 'grid' : 'list')}
            title={viewMode === 'list' ? '切换为卡片视图' : '切换为列表视图'}>
            {viewMode === 'list' ? <LayoutGrid className="size-3.5" /> : <LayoutList className="size-3.5" />}
          </Button>
        </div>
      )}

      {/* 拖拽上传提示 */}
      {dragOver && (
        <div className="absolute inset-0 bg-primary/10 z-50 flex items-center justify-center pointer-events-none">
          <span className="text-sm font-medium text-primary">释放文件以上传</span>
        </div>
      )}

      {/* 文件列表 / 卡片视图 */}
      {embedded ? (
        viewMode === 'grid' ? <FileGridView entries={entries} loading={loading} error={error} onSelect={handleSelect} onDelete={handleDeleteGrid} onDownload={handleDownload} /> : fileTree
      ) : viewMode === 'grid' ? (
        <ScrollArea className="flex-1"><FileGridView entries={entries} loading={loading} error={error} onSelect={handleSelect} onDelete={handleDeleteGrid} onDownload={handleDownload} /></ScrollArea>
      ) : (
        <ScrollArea className="flex-1">{fileTree}</ScrollArea>
      )}

      {/* 删除确认对话框 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCount > 1 ? (
                <>确定要删除选中的 <strong>{deleteCount}</strong> 个项目吗？</>
              ) : (
                <>
                  确定要删除 <strong>{deleteTarget?.name}</strong> 吗？
                  {deleteTarget?.isDirectory && '（包含所有子文件）'}
                </>
              )}
              此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ===== FileGridView 卡片视图 =====

function FileGridView({ entries, loading, error, onSelect, onDelete, onDownload }: {
  entries: FileEntry[]
  loading: boolean
  error: string | null
  onSelect: (entry: FileEntry, event: React.MouseEvent) => void
  onDelete?: (entry: FileEntry) => void
  onDownload?: (entry: FileEntry) => Promise<string | null>
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])
  if (loading) return <div className="flex items-center justify-center h-full text-muted-foreground text-xs">加载中...</div>
  if (error) return <div className="px-3 py-2 text-xs text-destructive">{error}</div>
  if (entries.length === 0) return <div className="px-3 py-4 text-xs text-muted-foreground text-center">目录为空</div>

  return (
    <div className="p-2 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(125px, 1fr))' }}>
      {entries.map((entry) => (
        <div
          key={entry.path}
          onClick={(e) => { if (menuOpen !== entry.path) onSelect(entry, e) }}
          className={cn(
            'group relative flex flex-col items-center gap-1.5 p-4 rounded-lg border border-transparent cursor-pointer',
            'hover:bg-accent/50 hover:border-border/60 transition-colors',
          )}
          style={{ aspectRatio: '3/4' }}
        >
          {/* 三点菜单（自定义实现，避免 Radix portal 被拦截） */}
          <div className="absolute top-1.5 right-1.5 z-20" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="h-7 w-7 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 bg-background/80 hover:bg-accent text-muted-foreground hover:text-foreground transition-opacity"
              onClick={() => setMenuOpen(menuOpen === entry.path ? null : entry.path)}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen === entry.path && (
              <div className="absolute right-0 top-8 w-36 bg-popover border rounded-md shadow-md py-1 z-50" onClick={(e) => e.stopPropagation()}>
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left"
                  onClick={() => { setMenuOpen(null); onSelect(entry, { metaKey: false, ctrlKey: false } as React.MouseEvent) }}
                >
                  <Eye size={14} />预览
                </button>
                {onDownload && entry.syncStatus === 'cloud-only' && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left"
                    onClick={() => { setMenuOpen(null); onDownload(entry) }}
                  >
                    <Download size={14} />下载到本地
                  </button>
                )}
                {onDelete && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-destructive text-left"
                    onClick={() => { setMenuOpen(null); onDelete(entry) }}
                  >
                    <Trash2 size={14} />删除
                  </button>
                )}
              </div>
            )}
          </div>

          <FileTypeIcon name={entry.name} isDirectory={entry.isDirectory} size={36} />
          <span className="text-[11px] text-center leading-tight line-clamp-2 break-all w-full">
            {entry.name}
          </span>

          {/* 底部信息行：同步状态 + 上传者 + 大小 */}
          <div className="flex items-center gap-1.5 w-full justify-center flex-wrap">
            {entry.syncStatus && entry.syncStatus !== 'synced' && (
              <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', {
                'bg-blue-400 animate-pulse': entry.syncStatus === 'syncing',
                'bg-amber-400': entry.syncStatus === 'cloud-only' || entry.syncStatus === 'local-only',
                'bg-red-400': entry.syncStatus === 'conflict',
              })} />
            )}
            {entry.uploadedByName && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground truncate max-w-[72px]" title={entry.uploadedByName}>
                {entry.uploadedByName}
              </span>
            )}
            {!entry.isDirectory && entry.size != null && (
              <span className="text-[10px] text-muted-foreground/60">{formatSize(entry.size)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// ===== FileTreeItem 子组件 =====

interface FileTreeItemProps {
  entry: FileEntry
  depth: number
  selectedPaths: Set<string>
  selectedCount: number
  renamingPath: string | null
  moving: boolean
  /** 文件版本号，变化时已展开的文件夹自动重新加载子项 */
  refreshVersion: number
  /** 自动定位：祖先目录路径集合（命中则自动展开） */
  revealAncestors: Set<string>
  /** 自动定位：目标文件路径（命中则滚动 + 高亮脉冲） */
  revealTarget: string | null
  /** 自动定位脉冲时间戳，变化时重新触发 */
  revealTs: number
  /** 本次 reveal 是否带 select 标记（来源于用户搜索点击）；为 true 时跳过 flash 高亮，避免覆盖选中色 */
  revealSelect: boolean
  /** 最近修改的路径集合（命中则在行左侧显示竖条标记） */
  recentlyModifiedSet: Set<string>
  onSelect: (entry: FileEntry, event: React.MouseEvent) => void
  onShowInFolder: (entry: FileEntry) => void
  onStartRename: (entry: FileEntry) => void
  onCancelRename: () => void
  onRename: (filePath: string, newName: string) => Promise<string | null>
  onDelete: (entry: FileEntry) => void
  onMove: (entry: FileEntry) => void
  onRefresh: () => Promise<void>
  onClearSelection: () => void
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (entry: FileEntry) => void
  onDownload?: (entry: FileEntry) => Promise<string | null>
}

function FileTreeItem({
  entry,
  depth,
  selectedPaths,
  selectedCount,
  renamingPath,
  moving,
  refreshVersion,
  revealAncestors,
  revealTarget,
  revealTs,
  revealSelect,
  recentlyModifiedSet,
  onSelect,
  onShowInFolder,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
  onMove,
  onRefresh,
  onClearSelection,
  onAddToChat,
  onFilePreview,
  onDownload,
}: FileTreeItemProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [children, setChildren] = React.useState<FileEntry[]>([])
  const [childrenLoaded, setChildrenLoaded] = React.useState(false)
  const [flash, setFlash] = React.useState(false)
  const rowRef = React.useRef<HTMLDivElement>(null)

  // 当 refreshVersion 变化时，已展开的文件夹自动重新加载子项
  React.useEffect(() => {
    if (expanded && childrenLoaded && entry.isDirectory) {
      window.electronAPI.listDirectory(entry.path)
        .then((items) => setChildren(items))
        .catch((err) => console.error('[FileTreeItem] 刷新子目录失败:', err))
    }
  }, [refreshVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== Agent 自动定位：祖先目录自动展开 + 目标行滚动到中心 + 0.8s 高亮脉冲 =====
  React.useEffect(() => {
    if (revealTs === 0) return

    const cleanups: Array<() => void> = []
    const isAncestor = revealAncestors.has(entry.path)
    const isTarget = revealTarget !== null && entry.path === revealTarget

    const scrollToTarget = (): void => {
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }

    // 自身需要展开：祖先目录 OR 目标本身就是目录（搜到文件夹时让其展开露出内容）
    const willExpand = entry.isDirectory && (isAncestor || isTarget) && !expanded
    if (willExpand) {
      let cancelled = false
      const run = async (): Promise<void> => {
        if (!childrenLoaded) {
          try {
            const items = await window.electronAPI.listDirectory(entry.path)
            if (!cancelled) {
              setChildren(items)
              setChildrenLoaded(true)
            }
          } catch (err) {
            console.error('[FileTreeItem] reveal 加载子目录失败:', err)
            return
          }
        }
        if (cancelled) return
        setExpanded(true)
        // 目标自身就是这个目录时，等展开后再滚动，避免子项渲染改变行高使
        // smooth scroll 的目标位置过时；加载失败路径不会到这里。
        if (isTarget) scrollToTarget()
      }
      void run()
      cleanups.push(() => { cancelled = true })
    }

    // 目标行：滚动到可视区中心 + 高亮脉冲
    if (isTarget) {
      // 仅在不会通过展开分支异步滚动时立即滚动（即：目标是文件，或已展开的目录）
      if (!willExpand) scrollToTarget()
      // 用户搜索点击场景（revealSelect=true）会同步把目标置为选中态，
      // flash 动画末关键帧的 transparent 背景会盖掉 bg-accent，造成"先闪一下再变选中"的视觉断层，
      // 因此该路径跳过 flash，仅保留滚动 + 选中态。Agent 自动定位（无 select）仍走 flash。
      // 注意：不要改 globals.css 里 .file-browser-row-flash 末关键帧的 transparent，那是 Agent
      // 路径下"动画结束行恢复无背景"的预期行为；选中态冲突应由本分支跳过 class 解决。
      if (!revealSelect) {
        setFlash(true)
        const t = setTimeout(() => setFlash(false), 1200)
        cleanups.push(() => clearTimeout(t))
      }
    }

    if (cleanups.length > 0) return () => { for (const c of cleanups) c() }
  }, [revealTs]) // eslint-disable-line react-hooks/exhaustive-deps

  // 重命名编辑状态
  const [editName, setEditName] = React.useState('')
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const renameInputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)

  const isSelected = selectedPaths.has(entry.path)
  const isRenaming = renamingPath === entry.path

  /** 展开/收起文件夹 */
  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return

    if (!expanded && !childrenLoaded) {
      if (entry.children) {
        setChildren(entry.children)
        setChildrenLoaded(true)
        setExpanded(true)
        return
      }
      try {
        const items = await window.electronAPI.listDirectory(entry.path)
        setChildren(items)
        setChildrenLoaded(true)

        // 首次展开空目录时，延迟重试一次（应对 Agent 正在写入文件的时序问题）
        if (items.length === 0) {
          setTimeout(async () => {
            try {
              const retryItems = await window.electronAPI.listDirectory(entry.path)
              if (retryItems.length > 0) setChildren(retryItems)
            } catch { /* 静默忽略 */ }
          }, 800)
        }
      } catch (err) {
        console.error('[FileTreeItem] 加载子目录失败:', err)
      }
    }

    setExpanded(!expanded)
  }

  /** 点击行为：选中 + 文件夹展开/收起 / 文件预览 */
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const isMulti = e.metaKey || e.ctrlKey
    onSelect(entry, e)
    if (isMulti) return
    if (entry.isDirectory) {
      void toggleDir()
    } else {
      onFilePreview?.(entry)
    }
  }

  /** 删除后刷新子目录 */
  const handleRefreshAfterDelete = async (): Promise<void> => {
    if (childrenLoaded) {
      try {
        const items = await window.electronAPI.listDirectory(entry.path)
        setChildren(items)
      } catch {
        await onRefresh()
      }
    }
  }

  // 进入重命名编辑模式
  React.useEffect(() => {
    if (isRenaming) {
      setEditName(entry.name)
      setRenameError(null)
      justStartedEditing.current = true
      const timer = setTimeout(() => {
        justStartedEditing.current = false
        const input = renameInputRef.current
        if (input) {
          input.focus()
          // 只选中文件名部分，不包括后缀
          const lastDotIndex = entry.name.lastIndexOf('.')
          if (lastDotIndex > 0 && !entry.isDirectory) {
            input.setSelectionRange(0, lastDotIndex)
          } else {
            input.select()
          }
        }
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [isRenaming, entry.name, entry.isDirectory])

  /** 保存重命名 */
  const saveRename = async (): Promise<void> => {
    if (justStartedEditing.current) return

    const trimmed = editName.trim()
    if (!trimmed || trimmed === entry.name) {
      onCancelRename()
      return
    }
    const error = await onRename(entry.path, trimmed)
    if (error) {
      setRenameError(error)
    }
  }

  /** 重命名键盘事件 */
  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancelRename()
    }
  }

  /** 重命名失焦 */
  const handleBlur = (): void => {
    if (renameError) {
      onCancelRename()
      setRenameError(null)
    } else {
      void saveRename()
    }
  }

  // 行使用 mx-2 形成左右各 8px 留白，留白处的点击 target 是本 wrapper 而非父级
  // py-1 容器，所以父级 handleBackgroundClick 的 target===currentTarget 判定不会命中。
  // 这里就近处理留白点击的清选语义，保持视觉上"点空白即清选"的一致体验。
  const handleWrapperClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClearSelection()
    }
  }

  const { paddingLeft, guideLeft, stickyTop, stickyZIndex } = computeTreeRowLayout(depth)
  const isSticky = entry.isDirectory && expanded && canBeSticky(depth)
  const showMenu = !isRenaming
  const menuSelectedCount = isSelected ? selectedCount : 1

  return (
    <div className="relative" onClick={handleWrapperClick}>
      <div
        ref={rowRef}
        data-sticky-row={isSticky ? 'true' : undefined}
        className={cn(
          'relative flex h-8 items-center gap-1 pr-2 text-sm cursor-pointer group transition-colors',
          isSticky && STICKY_ROW_BASE_CLASS,
          // sticky 行 hover 用不透明色，避免下方滚动内容透出；普通行保持半透明柔和感
          isSelected
            ? 'bg-accent'
            : isSticky
              ? 'hover:bg-accent'
              : 'hover:bg-accent/50',
          flash && 'file-browser-row-flash',
        )}
        style={{
          paddingLeft,
          top: isSticky ? stickyTop : undefined,
          zIndex: isSticky ? stickyZIndex : undefined,
        }}
        onClick={handleClick}
      >
        {/* sticky 行祖先链竖线，逻辑见 tree-row-layout.tsx 的 AncestorGuides */}
        {isSticky && <AncestorGuides depth={depth} isSelected={isSelected} />}
        {recentlyModifiedSet.has(entry.path) && (
          <span
            aria-label="最近被 Agent 修改"
            className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-primary/80"
            style={{ left: paddingLeft - 6 }}
          />
        )}
        {/* 展开/收起图标 */}
        {entry.isDirectory ? (
          <ChevronRight
            className={cn(
              'size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        {/* 文件/文件夹图标 */}
        <FileTypeIcon name={entry.name} isDirectory={entry.isDirectory} isOpen={expanded} />

        {/* 文件名 / 重命名输入框 */}
        {isRenaming ? (
          <div className="relative flex-1 min-w-0">
            <input
              ref={renameInputRef}
              value={editName}
              onChange={(e) => { setEditName(e.target.value); setRenameError(null) }}
              onKeyDown={handleRenameKeyDown}
              onBlur={handleBlur}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'w-full bg-transparent text-xs border-b outline-none py-0.5',
                renameError ? 'border-destructive' : 'border-primary/50',
              )}
              maxLength={255}
            />
            {renameError && (
              <div className="absolute left-0 top-full mt-0.5 text-[10px] leading-4 text-destructive whitespace-nowrap pointer-events-none">
                {renameError}
              </div>
            )}
          </div>
        ) : (
          <span className="truncate text-xs flex-1">{entry.name}</span>
        )}

        {/* 文件同步状态指示（团队工作区） */}
        {entry.syncStatus && entry.syncStatus !== 'synced' && (
          <span
            className={cn('flex-shrink-0 w-2 h-2 rounded-full', {
              'bg-blue-400 animate-pulse': entry.syncStatus === 'syncing',
              'bg-amber-400': entry.syncStatus === 'cloud-only' || entry.syncStatus === 'local-only',
              'bg-red-400': entry.syncStatus === 'conflict',
            })}
            title={
              entry.syncStatus === 'syncing' ? '同步中' :
              entry.syncStatus === 'cloud-only' ? '仅云端' :
              entry.syncStatus === 'local-only' ? '仅本地' :
              entry.syncStatus === 'conflict' ? '有冲突' : ''
            }
          />
        )}

        {/* 右侧操作按钮占位（始终占位，避免行宽跳动） */}
        <div
          className="flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 悬浮/选中状态：三点菜单 */}
          {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70 text-muted-foreground hover:text-foreground',
                  !isSelected && 'invisible group-hover:visible focus-visible:visible data-[state=open]:visible',
                )}
                title="更多操作"
                aria-label="更多操作"
                onClick={(e) => {
                  if (!isSelected) onSelect(entry, e)
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                {onDownload && entry.syncStatus === 'cloud-only' && menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onDownload(entry)}
                  >
                    <Download />
                    下载到本地
                  </DropdownMenuItem>
                )}
                {onAddToChat && !entry.isDirectory && menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onAddToChat(entry)}
                  >
                    <MessageSquarePlus />
                    添加到聊天
                  </DropdownMenuItem>
                )}
                {menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onShowInFolder(entry)}
                  >
                    <FolderSearch />
                    在文件夹中显示
                  </DropdownMenuItem>
                )}
                {menuSelectedCount === 1 && !entry.isDirectory && (
                  <DefaultAppMenuItem
                    filePath={entry.path}
                    probePath={entry.name}
                    resolveFilePath={onDownload && entry.syncStatus ? () => onDownload(entry) : undefined}
                    className="text-xs py-1 [&>svg]:size-3.5"
                  />
                )}
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  disabled={moving}
                  onSelect={() => { void onMove(entry) }}
                >
                  <FolderInput />
                  {menuSelectedCount > 1 ? `移动选中 (${menuSelectedCount})` : '移动到...'}
                </DropdownMenuItem>
                {menuSelectedCount === 1 && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onStartRename(entry)}
                  >
                    <Pencil />
                    重命名
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className="my-0.5" />
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5 text-destructive"
                  onSelect={() => onDelete(entry)}
                >
                  <Trash2 />
                  {menuSelectedCount > 1 ? `删除选中 (${menuSelectedCount})` : '删除'}
                </DropdownMenuItem>
              </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      </div>

      {/* 子项 */}
      {expanded && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 top-0 w-px bg-border/70"
            style={{ left: guideLeft }}
          />
          {children.length === 0 && childrenLoaded && (
            <div
              className="text-[11px] text-muted-foreground/50 py-1"
              style={{ paddingLeft: paddingLeft + 24 }}
            >
              空文件夹
            </div>
          )}
          {children.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPaths={selectedPaths}
              selectedCount={selectedCount}
              renamingPath={renamingPath}
              moving={moving}
              refreshVersion={refreshVersion}
              revealAncestors={revealAncestors}
              revealTarget={revealTarget}
              revealTs={revealTs}
              revealSelect={revealSelect}
              recentlyModifiedSet={recentlyModifiedSet}
              onSelect={onSelect}
              onShowInFolder={onShowInFolder}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onRefresh={handleRefreshAfterDelete}
              onClearSelection={onClearSelection}
              onAddToChat={onAddToChat}
              onFilePreview={onFilePreview}
              onDownload={onDownload}
            />
          ))}
        </div>
      )}

    </div>
  )
}
