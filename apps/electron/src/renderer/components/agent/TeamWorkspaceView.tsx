/**
 * TeamWorkspaceView — 团队工作区主视图
 *
 * 主区域：文件浏览器（卡片/列表），右侧面板：AI 对话
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, getDefaultStore } from 'jotai'
import { toast } from 'sonner'
import {
  Upload, RefreshCw, LayoutGrid, LayoutList,
  Plus, Search, Users, FolderOpen, FolderPlus, FolderUp, Trash2, Download,
  MoreHorizontal, Eye, Loader2, Cloud, CloudOff, ChevronDown, ChevronRight,
  ExternalLink, FolderSearch, ArrowUpDown, ArrowUp, Square, CheckSquare,
  PanelRightClose, PanelRightOpen, MessageSquarePlus,
} from 'lucide-react'
import {
  agentSessionsAtom,
  agentPendingFilesAtomFamily,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
  workspaceFilesVersionAtom,
} from '@/atoms/agent-atoms'
import { TabContent } from '@/components/tabs/TabContent'
import { CompactModelSelectorCtx } from '@/components/chat/ModelSelector'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import { useTrackSessionView } from '@/hooks/useTrackSessionView'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { FilePreviewDialog } from '@/components/file-browser/FilePreviewDialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { WindowControls } from '@/components/WindowControls'
import { cn } from '@/lib/utils'
import { detectIsWindows } from '@/lib/platform'
import type { AgentPendingFile, FileEntry } from '@proma/shared'

function getMediaTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  }
  return ext ? (map[ext] ?? 'application/octet-stream') : 'application/octet-stream'
}

function createTeamFileDragPayload(entry: FileEntry): string {
  const { children: _children, ...payload } = entry
  return JSON.stringify(payload)
}

function isTeamFileTransfer(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('application/x-proma-team-file')
}

export function TeamWorkspaceView(): React.ReactElement {
  useTrackSessionView()

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspace = workspaces.find((w) => w.id === currentId)
  const teamId = workspace?.type === 'team' ? workspace.id : undefined
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const deferredActiveTabId = React.useDeferredValue(activeTabId)
  const activeTab = tabs.find((tab) => tab.id === deferredActiveTabId)
  const activeTabAgentSessionId = activeTab && (activeTab.type === 'agent' || activeTab.type === 'preview')
    ? activeTab.sessionId
    : null

  // 团队工作区专属：从 tabs 中找第一场属于本工作区的 Agent 会话
  const teamAgentTab = React.useMemo(() => {
    if (!teamId) return null
    return tabs.find((t) => {
      if (t.type !== 'agent' && t.type !== 'preview') return false
      const session = agentSessions.find((s) => s.id === (t as { sessionId?: string }).sessionId)
      return session?.workspaceId === teamId
    }) ?? null
  }, [tabs, agentSessions, teamId])

  const teamAgentTabId = (teamAgentTab as { id?: string })?.id ?? null

  const currentTeamSessionId = currentAgentSessionId && agentSessions.some((session) => (
    session.id === currentAgentSessionId && session.workspaceId === teamId
  ))
    ? currentAgentSessionId
    : null

  // 优先团队 Agent Tab，其次当前团队会话
  const activeAgentSessionId = activeTabAgentSessionId ?? (currentTeamSessionId ?? (teamAgentTab ? (teamAgentTab as { sessionId: string }).sessionId : null))
  const setActiveAgentPendingFiles = useSetAtom(agentPendingFilesAtomFamily(activeAgentSessionId ?? '__team-agent-drop__'))

  // 文件状态
  const [filesPath, setFilesPath] = React.useState<string | null>(null)
  const [entries, setEntries] = React.useState<FileEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<'grid' | 'list'>('grid')
  const [uploading, setUploading] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<{ path: string; name: string; download?: () => Promise<string | null> } | null>(null)
  const [memberCount, setMemberCount] = React.useState(0)
  const [onlineCount, setOnlineCount] = React.useState(0)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [uploadMenuOpen, setUploadMenuOpen] = React.useState(false)
  const [dragOverFolder, setDragOverFolder] = React.useState<string | null>(null)
  const [currentPath, setCurrentPath] = React.useState<string | null>(null)
  const [sortBy, setSortBy] = React.useState<'name' | 'date' | 'size'>('name')
  const [sortAsc, setSortAsc] = React.useState(true)
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchActive, setSearchActive] = React.useState(false)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set())
  const [batchDeleting, setBatchDeleting] = React.useState(false)
  const [dragSourceInternal, setDragSourceInternal] = React.useState(false)
  const [agentPanelCollapsed, setAgentPanelCollapsed] = React.useState(false)
  const [agentDropOver, setAgentDropOver] = React.useState(false)

  // 全局阻止浏览器对拖入文件的默认处理
  React.useEffect(() => {
    const preventDefaults = (e: DragEvent) => { e.preventDefault() }
    document.addEventListener('dragover', preventDefaults, false)
    document.addEventListener('drop', preventDefaults, false)
    return () => {
      document.removeEventListener('dragover', preventDefaults, false)
      document.removeEventListener('drop', preventDefaults, false)
    }
  }, [])

  // 拖拽离开延迟隐藏 timer
  const dragLeaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // 关闭菜单
  React.useEffect(() => {
    if (!menuOpen && !sortMenuOpen && !uploadMenuOpen) return
    const close = () => { setMenuOpen(null); setSortMenuOpen(false); setUploadMenuOpen(false) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen, sortMenuOpen, uploadMenuOpen])

  // 加载路径
  React.useEffect(() => {
    if (workspace?.slug) {
      window.electronAPI.getWorkspaceFilesPath(workspace.slug).then(setFilesPath).catch(() => setFilesPath(null))
    }
  }, [workspace?.slug])

  // 加载成员数
  React.useEffect(() => {
    if (teamId) {
      window.electronAPI.team.getMembers(teamId).then((m: any[]) => {
        setMemberCount(m.length)
        setOnlineCount(m.filter((x) => x.isOnline).length)
      }).catch(() => {})
    }
  }, [teamId])

  const initialLoadDoneRef = React.useRef(false)

  // 加载文件清单
  const loadFiles = React.useCallback(async (silent = false) => {
    if (!filesPath || !teamId) return
    if (!silent) setLoading(true)
    try {
      const manifest = await window.electronAPI.teamFile.getManifest(teamId, workspace?.slug).catch(() => [] as Awaited<ReturnType<typeof window.electronAPI.teamFile.getManifest>>)
      const items: FileEntry[] = manifest.map((f: Record<string, unknown>) => {
        return {
          name: f.name as string, path: f.path as string, isDirectory: (f.isDirectory as boolean) ?? false, size: f.size as number,
          syncStatus: (f.syncStatus as FileEntry['syncStatus']) ?? ((f.localExists as boolean) ? 'synced' : 'cloud-only'),
          uploadedBy: (f.uploadedBy as string) ?? '', uploadedByName: (f.uploadedByName as string) ?? '',
          remoteModifiedAt: (f.modifiedAt as number) ?? undefined,
        }
      })
      setEntries(items)
    } catch (e) { /* ignore */ }
    finally {
      if (!silent) setLoading(false)
      initialLoadDoneRef.current = true
    }
  }, [filesPath, teamId, workspace?.slug])

  // 首次加载显示 loading；后续 filesVersion 变化时静默刷新，避免闪烁
  React.useEffect(() => {
    loadFiles(!initialLoadDoneRef.current)
  }, [loadFiles, filesVersion])

  const [failedUploads, setFailedUploads] = React.useState<Array<{ name: string; size: number }>>([])
  const failedDataRef = React.useRef<Map<string, ArrayBuffer>>(new Map())

  /** 递归读取拖拽的目录结构，保留路径层级 */
  const readDroppedEntries = React.useCallback(async (
    items: DataTransferItemList,
  ): Promise<Array<{ file: File; relativePath: string }>> => {
    const result: Array<{ file: File; relativePath: string }> = []

    const readEntry = async (entry: FileSystemEntry, parentPath: string): Promise<void> => {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject)
        })
        result.push({ file, relativePath: parentPath ? `${parentPath}/${entry.name}` : entry.name })
      } else if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry
        const reader = dirEntry.createReader()
        const dirPath = parentPath ? `${parentPath}/${entry.name}` : entry.name
        // readEntries 可能分批返回，需要循环直到返回空数组
        const readAllEntries = (): Promise<FileSystemEntry[]> => {
          return new Promise((resolve) => {
            const all: FileSystemEntry[] = []
            const readBatch = () => {
              reader.readEntries((entries) => {
                if (entries.length === 0) { resolve(all); return }
                all.push(...entries)
                readBatch()
              })
            }
            readBatch()
          })
        }
        const children = await readAllEntries()
        for (const child of children) {
          await readEntry(child, dirPath)
        }
      }
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || item.kind !== 'file') continue
      const entry = (item as any).webkitGetAsEntry?.() as FileSystemEntry | null
      if (entry) {
        await readEntry(entry, '')
      } else {
        // 兼容不支持 webkitGetAsEntry 的情况
        const file = item.getAsFile()
        if (file) result.push({ file, relativePath: file.name })
      }
    }
    return result
  }, [])

  const handleUpload = React.useCallback(async (files: FileList | File[], retryNames?: string[], parentPath?: string) => {
    if (!teamId || !workspace?.slug) { console.error('[TeamView] 上传失败: teamId或slug为空', teamId, workspace?.slug); return }
    console.log('[TeamView] 开始上传', Array.from(files).map(f => f.name), 'parentPath:', parentPath, 'teamId:', teamId)
    setUploading(true)
    if (!retryNames) setFailedUploads([])
    const arr = Array.from(files)
    const failed: Array<{ name: string; size: number }> = []
    for (const file of arr) {
      try {
        // 拖拽文件夹时 file.webkitRelativePath 包含相对路径；拖拽到文件夹时拼接 parentPath
        const base = (file as any).webkitRelativePath || file.name
        const relPath = parentPath ? `${parentPath}/${base}` : base
        const buf = await file.arrayBuffer()
        const data = new Uint8Array(buf)
        let sourcePath = ''
        try {
          sourcePath = window.electronAPI.getPathForFile(file)
        } catch {
          sourcePath = ''
        }
        // 1. 上传到服务器
        const result = await window.electronAPI.teamFile.upload({
          workspaceId: teamId,
          workspaceSlug: workspace.slug,
          fileName: relPath,
          fileData: data,
          sourcePath: sourcePath || undefined,
        })
        console.log('[TeamView] 上传结果:', relPath, result)
        if (!result.success) { console.error('[TeamView] 上传失败:', relPath, result.error); failed.push({ name: relPath, size: file.size }); failedDataRef.current.set(relPath, buf) }
      } catch (err) { console.error('[TeamView] 上传异常:', file.name, err); failed.push({ name: file.name, size: file.size }); failedDataRef.current.set(file.name, await file.arrayBuffer().catch(() => new ArrayBuffer(0))) }
    }
    setFailedUploads(failed)
    setUploading(false)
    if (failed.length) toast.error(`${failed.length} 个文件上传失败`)
    else toast.success('上传完成')
    setTimeout(() => loadFiles(), 300)
  }, [teamId, workspace?.slug, loadFiles])

  // 内部拖拽移动文件/文件夹
  const handleMove = React.useCallback(async (fromPath: string, toDir: string) => {
    if (!teamId || !workspace?.slug) return
    const fromParent = fromPath.lastIndexOf('/') >= 0 ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
    if (fromParent === toDir) return
    if (toDir && toDir.startsWith(fromPath + '/')) return

    console.log('[DnD] 调用 teamFile.move API...', { fromPath, toDir })
    let result: { success: boolean; fromPath: string; toPath?: string; error?: string }
    try {
      result = await window.electronAPI.teamFile.move({
        workspaceId: teamId, workspaceSlug: workspace.slug, fromPath, toDir,
      })
    } catch (err: any) {
      console.error('[DnD] API 调用异常:', err)
      toast.error('移动失败: ' + (err?.message || String(err)))
      return
    }
    console.log('[DnD] API 返回:', result)
    if (!result.success) {
      toast.error(result.error || '移动失败')
      return
    }

    // 服务端已成功。本地清理旧文件，防止残留
    if (filesPath) {
      const oldLocal = `${filesPath}/${fromPath}`
      console.log('[DnD] 删除本地旧路径:', oldLocal)
      window.electronAPI.deleteFile(oldLocal).catch((e) => console.warn('[DnD] deleteFile 失败:', e))
    }

    toast.success('已移动')
    setEntries((prev) => {
      const filtered = prev.filter((x) => x.path !== fromPath && !x.path.startsWith(fromPath + '/'))
      console.log('[DnD] 乐观更新: 清除', fromPath, '剩余条目:', filtered.length)
      return filtered
    })
    // 延迟刷新确保服务端写入完成
    setTimeout(async () => {
      await loadFiles()
      // 验证
      const manifest = await window.electronAPI.teamFile.getManifest(teamId, workspace?.slug).catch(() => [] as any[])
      const ghost = manifest.some((f: any) => f.path === fromPath)
      console.log(ghost ? '[DnD] 失败: 旧路径仍存在!' : '[DnD] 验证通过: 旧路径已清除')
    }, 500)
  }, [teamId, workspace?.slug, filesPath, loadFiles])

  /** 统一的拖放处理（仅外部文件上传） */
  const handleDropFiles = React.useCallback(async (e: React.DragEvent, targetDir?: string) => {
    e.preventDefault()
    setDragOver(false)
    setDragOverFolder(null)
    setDragSourceInternal(false)

    const items = e.dataTransfer.items
    if (items && items.length > 0) {
      const entries = await readDroppedEntries(items)
      if (entries.length > 0) {
        const files = entries.map((x) => {
          Object.defineProperty(x.file, 'webkitRelativePath', { value: x.relativePath, writable: false })
          return x.file
        })
        handleUpload(files, undefined, targetDir)
        return
      }
    }
    const dtFiles = e.dataTransfer.files
    if (dtFiles && dtFiles.length > 0) {
      handleUpload(dtFiles, undefined, targetDir)
    }
  }, [readDroppedEntries, handleUpload])

  /** 使用原生对话框选择并上传文件夹 */
  const handleUploadFolder = React.useCallback(async () => {
    if (!teamId || !workspace?.slug) return
    const items = await window.electronAPI.selectAndUploadFolder()
    if (!items || items.length === 0) return
    setUploading(true)
    let count = 0
    for (const item of items) {
      try {
        const result = await window.electronAPI.teamFile.upload({
          workspaceId: teamId, workspaceSlug: workspace.slug,
          fileName: item.relativePath, fileData: item.data,
          sourcePath: item.sourcePath,
        })
        if (result.success) count++
      } catch (e) { /* continue */ }
    }
    setUploading(false)
    if (count > 0) { toast.success(`已上传 ${count} 个文件`); setTimeout(() => loadFiles(), 300) }
    else toast.error('上传失败')
  }, [teamId, workspace?.slug, loadFiles])

  const retryFailed = async () => {
    const retryFiles = failedUploads.map((f) => {
      const cached = failedDataRef.current.get(f.name)
      return new File([cached ?? new ArrayBuffer(f.size)], f.name)
    })
    await handleUpload(retryFiles, retryFiles.map((f) => f.name))
  }

  /** 新建文件夹 */
  const [showNewFolder, setShowNewFolder] = React.useState(false)
  const [newFolderName, setNewFolderName] = React.useState('')
  const handleCreateFolder = React.useCallback(async () => {
    const name = newFolderName.trim()
    if (!name || !teamId || !workspace?.slug) return
    const fullPath = currentPath ? `${currentPath}/${name}` : name
    const ok = await window.electronAPI.teamFile.createDirectory({ workspaceId: teamId, dirPath: fullPath })
    if (ok) {
      toast.success('文件夹已创建')
      setNewFolderName('')
      setShowNewFolder(false)
      setTimeout(() => loadFiles(), 300)
    } else {
      toast.error('创建失败')
    }
  }, [newFolderName, teamId, workspace?.slug, loadFiles])

  const retrySingle = async (fileName: string) => {
    const f = failedUploads.find((x) => x.name === fileName)
    if (f) {
      const cached = failedDataRef.current.get(fileName)
      const retryFile = new File([cached ?? new ArrayBuffer(f.size)], f.name)
      setFailedUploads((prev) => prev.filter((x) => x.name !== fileName))
      await handleUpload([retryFile])
    }
  }

  // 树状展开状态
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set())

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // 排序函数
  const sortItems = React.useCallback((items: FileEntry[]) => {
    const sorted = [...items].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      let cmp = 0
      switch (sortBy) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'size': cmp = (a.size || 0) - (b.size || 0); break
        case 'date': cmp = (a.remoteModifiedAt || 0) - (b.remoteModifiedAt || 0); break
      }
      return sortAsc ? cmp : -cmp
    })
    return sorted
  }, [sortBy, sortAsc])

  // 把失败的文件也显示在列表里
  const allEntries = React.useMemo(() => {
    const result = [...entries]
    for (const f of failedUploads) {
      if (!result.some((e) => e.name === f.name)) {
        result.unshift({
          name: f.name, path: f.name, isDirectory: false, size: f.size,
          syncStatus: 'local-only' as FileEntry['syncStatus'],
        })
      }
    }
    return result
  }, [entries, failedUploads])

  // 判断 entry 是否为 parent 目录的直接子项
  // parent 为空时表示根目录：直接子项 = 路径中不含 '/'
  const isDirectChild = React.useCallback((entryPath: string, parent: string) => {
    if (!parent) return entryPath.indexOf('/') === -1
    if (!entryPath.startsWith(parent + '/')) return false
    const rest = entryPath.slice(parent.length + 1)
    return rest.indexOf('/') === -1
  }, [])

  // 搜索过滤
  const filteredEntries = React.useMemo(() => {
    if (!searchQuery.trim()) return allEntries
    const q = searchQuery.toLowerCase()
    return allEntries.filter((e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q))
  }, [allEntries, searchQuery])

  // 下载文件到本地
  const handleDownload = async (entry: FileEntry): Promise<string | null> => {
    if (!teamId || !workspace?.slug) return null
    try {
      const local = await window.electronAPI.teamFile.download({ workspaceId: teamId, workspaceSlug: workspace.slug, filePath: entry.path, uploadedBy: entry.uploadedBy })
      if (local) { toast.success('已下载到本地'); loadFiles(); return local }
      else toast.error('下载失败')
    } catch { toast.error('下载失败') }
    return null
  }

  // 预览
  const handlePreview = (entry: FileEntry) => {
    if (entry.isDirectory) return
    setPreview({
      path: entry.path,
      name: entry.name,
      download: teamId ? async () => {
        const local = await window.electronAPI.teamFile.download({ workspaceId: teamId, workspaceSlug: workspace?.slug!, filePath: entry.path, uploadedBy: entry.uploadedBy })
        return local
      } : undefined,
    })
  }

  const showAgentSession = React.useCallback((sessionId: string): void => {
    const session = agentSessions.find((item) => item.id === sessionId)
    const result = openTab(tabs, {
      type: 'agent',
      sessionId,
      title: session?.title ?? 'Agent 会话',
    })
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    setAppMode('agent')
    setCurrentConversationId(null)
    setCurrentAgentSessionId(sessionId)
    setUnviewedCompleted((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    if (session?.workspaceId) {
      setCurrentAgentWorkspaceId(session.workspaceId)
      window.electronAPI.updateSettings({
        agentWorkspaceId: session.workspaceId,
      }).catch(console.error)
    }
  }, [
    agentSessions,
    setActiveTabId,
    setAppMode,
    setCurrentAgentSessionId,
    setCurrentAgentWorkspaceId,
    setCurrentConversationId,
    setTabs,
    setUnviewedCompleted,
    tabs,
  ])

  const addTeamFileToAgent = React.useCallback(async (entry: FileEntry): Promise<void> => {
    if (!teamId || !workspace?.slug) return
    if (entry.isDirectory) {
      toast.info('文件夹暂不支持直接拖入 Agent，请拖入具体文件')
      return
    }

    // 没有活跃 Agent 会话时自动创建一个
    let targetSessionId = activeAgentSessionId
    if (!targetSessionId) {
      try {
        const session = await window.electronAPI.createAgentSession(undefined, undefined, teamId)
        showAgentSession(session.id)
        targetSessionId = session.id
      } catch {
        toast.error('创建 Agent 对话失败')
        return
      }
    }

    const local = await window.electronAPI.teamFile.download({
      workspaceId: teamId,
      workspaceSlug: workspace.slug,
      filePath: entry.path,
      uploadedBy: entry.uploadedBy,
    })
    if (!local) {
      toast.error('文件还没有准备好，无法添加到 Agent')
      return
    }

    const pending: AgentPendingFile = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: entry.name,
      mediaType: getMediaTypeFromFilename(entry.name),
      size: entry.size ?? 0,
      sourcePath: local,
    }

    // 自动创建会话后，用 getDefaultStore 直接写入 pending files
    getDefaultStore().set(agentPendingFilesAtomFamily(targetSessionId), (prev) => {
      if (prev.some((file) => file.sourcePath === local)) return prev
      return [...prev, pending]
    })
    showAgentSession(targetSessionId)
    toast.success(`已添加到 Agent：${entry.name}`)
  }, [activeAgentSessionId, showAgentSession, teamId, workspace?.slug])

  const handleAgentDragOver = React.useCallback((e: React.DragEvent): void => {
    if (!isTeamFileTransfer(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(false)
    setDragOverFolder(null)
    setAgentDropOver(true)
  }, [activeAgentSessionId])

  const handleAgentDragLeave = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const relatedTarget = e.relatedTarget as Node | null
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) return
    setAgentDropOver(false)
  }, [])

  const handleAgentDrop = React.useCallback((e: React.DragEvent): void => {
    if (!isTeamFileTransfer(e.dataTransfer)) return
    const payload = e.dataTransfer.getData('application/x-proma-team-file')
    if (!payload) return
    e.preventDefault()
    e.stopPropagation()
    setAgentDropOver(false)
    setDragOver(false)
    setDragOverFolder(null)
    setDragSourceInternal(false)
    try {
      const entry = JSON.parse(payload) as FileEntry
      void addTeamFileToAgent(entry)
      setAgentPanelCollapsed(false)
    } catch (error) {
      console.error('[TeamView] 团队文件拖入 Agent 失败:', error)
      toast.error('添加到 Agent 失败')
    }
  }, [addTeamFileToAgent])

  // 删除
  const handleDelete = async (entry: FileEntry) => {
    if (!teamId || !workspace?.slug) return
    const ok = await window.electronAPI.teamFile.delete({ workspaceId: teamId, workspaceSlug: workspace.slug, filePath: entry.path }).catch(() => false)
    if (ok) {
      // 同步删除本地文件/文件夹
      if (filesPath) {
        const localPath = `${filesPath}/${entry.path}`
        window.electronAPI.deleteFile(localPath).catch(() => {})
      }
      toast.success('已删除')
      setEntries((prev) => prev.filter((x) => x.path !== entry.path))
      setTimeout(() => loadFiles(), 500)
    } else {
      toast.error('删除失败')
    }
  }

  // 构建树状结构用于列表视图
  const treeEntries = React.useMemo(() => {
    const dirMap = new Map<string, FileEntry>()
    const root: FileEntry[] = []
    const sorted = [...filteredEntries].sort((a, b) => {
      const aLen = (a.path.match(/\//g) || []).length
      const bLen = (b.path.match(/\//g) || []).length
      return aLen - bLen
    })
    for (const entry of sorted) {
      const slashIdx = entry.path.lastIndexOf('/')
      if (slashIdx === -1) {
        root.push({ ...entry, children: entry.isDirectory ? [] : undefined })
        if (entry.isDirectory) dirMap.set(entry.path, root[root.length - 1]!)
      } else {
        const parentPath = entry.path.slice(0, slashIdx)
        const parent = dirMap.get(parentPath)
        const node: FileEntry = { ...entry, children: entry.isDirectory ? [] : undefined }
        if (parent?.children) {
          parent.children.push(node)
        } else {
          root.push(node)
        }
        if (entry.isDirectory) dirMap.set(entry.path, node)
      }
    }
    const sortFn = (items: FileEntry[]): FileEntry[] => {
      const sorted = sortItems(items)
      return sorted.map((item) =>
        item.children ? { ...item, children: sortFn(item.children) } : item,
      )
    }
    return sortFn(root)
  }, [filteredEntries, sortItems])

  // 批量选择
  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const visiblePaths = React.useMemo(() => {
    const visible = filteredEntries.filter((e) => isDirectChild(e.path, currentPath || ''))
    return new Set(visible.map((e) => e.path))
  }, [filteredEntries, currentPath, isDirectChild])

  const toggleSelectAll = () => {
    setSelectedPaths((prev) => {
      if ([...visiblePaths].every((p) => prev.has(p))) {
        const next = new Set(prev)
        for (const p of visiblePaths) next.delete(p)
        return next
      }
      return new Set([...prev, ...visiblePaths])
    })
  }

  // 计算每个文件夹的直接子项数量（用于网格卡片展示）
  const folderItemCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of allEntries) {
      if (e.isDirectory) continue
      const slashIdx = e.path.lastIndexOf('/')
      const parentPath = slashIdx === -1 ? '' : e.path.slice(0, slashIdx)
      counts.set(parentPath, (counts.get(parentPath) || 0) + 1)
    }
    // 也统计子目录数量
    for (const e of allEntries) {
      if (!e.isDirectory) continue
      const slashIdx = e.path.lastIndexOf('/')
      const parentPath = slashIdx === -1 ? '' : e.path.slice(0, slashIdx)
      counts.set(parentPath, (counts.get(parentPath) || 0) + 1)
    }
    return counts
  }, [allEntries])

  const allSelected = visiblePaths.size > 0 && [...visiblePaths].every((p) => selectedPaths.has(p))
  const selectedCount = [...selectedPaths].filter((p) => visiblePaths.has(p)).length

  const batchDownload = async () => {
    if (!teamId || !workspace?.slug) return
    const pathsToDownload = [...selectedPaths]
    setSelectedPaths(new Set())
    let count = 0
    for (const path of pathsToDownload) {
      const entry = filteredEntries.find((e) => e.path === path)
      if (!entry || entry.isDirectory) continue
      try {
        const local = await window.electronAPI.teamFile.download({ workspaceId: teamId, workspaceSlug: workspace.slug, filePath: path, uploadedBy: entry.uploadedBy })
        if (local) count++
      } catch { /* continue */ }
    }
    if (count > 0) { toast.success(`已下载 ${count} 个文件`); loadFiles() }
  }

  const batchDelete = async () => {
    if (!teamId || !workspace?.slug) return
    const pathsToDelete = [...selectedPaths]
    // 乐观更新：立即从本地状态移除
    setEntries((prev) => prev.filter((e) => !pathsToDelete.includes(e.path)))
    setSelectedPaths(new Set())
    setBatchDeleting(true)
    let count = 0
    for (const path of pathsToDelete) {
      try {
        const ok = await window.electronAPI.teamFile.delete({ workspaceId: teamId, workspaceSlug: workspace.slug, filePath: path })
        if (ok) {
          if (filesPath) {
            const localPath = `${filesPath}/${path}`
            window.electronAPI.deleteFile(localPath).catch(() => {})
          }
          count++
        }
      } catch { /* continue */ }
    }
    setBatchDeleting(false)
    if (count > 0) { toast.success(`已删除 ${count} 项`); setTimeout(() => loadFiles(), 500) }
    else if (count === 0) { loadFiles() } // 删除全部失败则恢复
  }

  // 容器级拖拽：dragEnter 清除 timer + 显示，dragLeave 设延迟隐藏
  const handleContainerDragEnter = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null }
    const isInternal = Array.from(e.dataTransfer.types).includes('application/x-proma-move')
    setDragSourceInternal(isInternal) // 每次拖入都重置，防止上次残留
    if (isInternal) return
    setDragOver(true)
  }, [])
  const handleContainerDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragLeaveTimer.current = setTimeout(() => { setDragOver(false); setDragOverFolder(null) }, 200)
  }, [])
  const handleContainerDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null }
    const targetDir = dragOverFolder ?? currentPath ?? ''
    setDragOver(false)
    setDragOverFolder(null)
    setDragSourceInternal(false)
    const src = e.dataTransfer.getData('application/x-proma-move')
    if (src) { handleMove(src, targetDir); return }
    handleDropFiles(e, targetDir || undefined)
  }, [handleMove, handleDropFiles, currentPath, dragOverFolder])

  const empty = !loading && filteredEntries.length === 0 && failedUploads.length === 0

  // 递归树行组件（支持拖拽到文件夹、双击进入）
  const TreeRow = React.useCallback(({ entry, depth }: { entry: FileEntry; depth: number }) => {
    const isDir = entry.isDirectory
    const isExpanded = expandedPaths.has(entry.path)
    const isDragTarget = dragOverFolder === entry.path
    const children = entry.children
    return (
      <React.Fragment key={entry.path}>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-proma-move', entry.path)
            e.dataTransfer.setData('application/x-proma-team-file', createTeamFileDragPayload(entry))
            e.dataTransfer.effectAllowed = 'copyMove'
            setDragSourceInternal(true)
          }}
          onDragEnd={() => setDragSourceInternal(false)}
          className={cn(
            'group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer text-sm transition-all',
            isDragTarget ? 'bg-primary/20 ring-2 ring-primary/40 scale-[1.02] shadow-lg shadow-primary/10' : 'hover:bg-accent/30',
          )}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => isDir ? toggleExpand(entry.path) : handlePreview(entry)}
          onDoubleClick={() => { if (isDir) setCurrentPath(entry.path) }}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (isDir) { e.dataTransfer.dropEffect = 'move'; setDragOverFolder(entry.path) }
            else e.dataTransfer.dropEffect = 'none'
          }}
          onDragLeave={(e) => { e.stopPropagation(); setDragOverFolder(null) }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null }
            setDragOver(false); setDragSourceInternal(false); setDragOverFolder(null)
            if (!isDir) return
            const src = e.dataTransfer.getData('application/x-proma-move')
            if (src && src !== entry.path) handleMove(src, entry.path)
            else if (!src) handleDropFiles(e, entry.path)
          }}
        >
          {/* 选择框 */}
          <span className="flex-shrink-0 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <button
              className={cn('h-4 w-4 rounded flex items-center justify-center transition-all',
                selectedPaths.has(entry.path)
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border/50 hover:border-primary/50 opacity-0 group-hover:opacity-100',
              )}
              onClick={() => toggleSelect(entry.path)}>
              {selectedPaths.has(entry.path) && <CheckSquare size={10} />}
            </button>
          </span>
          {/* 展开/折叠 */}
          <span className="w-4 flex-shrink-0 flex items-center justify-center">
            {isDir && children && children.length > 0 ? (
              <ChevronRight size={14} className={cn('transition-transform', isExpanded && 'rotate-90')} />
            ) : isDir ? (
              <FolderOpen size={14} className="text-blue-400" />
            ) : null}
          </span>
          {/* 同步状态 */}
          {entry.syncStatus === 'cloud-only' ? <Cloud size={14} className="text-amber-400 flex-shrink-0" /> :
           entry.syncStatus === 'synced' ? <span className="text-green-500 text-[10px] flex-shrink-0 w-4 text-center">✓</span> :
           <CloudOff size={14} className="text-muted-foreground/30 flex-shrink-0" />}
          {/* 图标 */}
          <span className="flex-shrink-0 pointer-events-none">
            <FileTypeIcon name={entry.name} isDirectory={isDir} size={18} />
          </span>
          {/* 名称 */}
          <span className="flex-1 truncate">{entry.name}</span>
          {/* 上传者 */}
          {entry.uploadedByName && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground flex-shrink-0">{entry.uploadedByName}</span>
          )}
          {/* 大小 */}
          {!isDir && entry.size != null && (
            <span className="text-[10px] text-muted-foreground/50 w-12 text-right flex-shrink-0">{formatSize(entry.size)}</span>
          )}
          {/* 操作按钮 */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
            {entry.syncStatus === 'cloud-only' && (
              <button className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent" title="下载到本地" onClick={(e) => { e.stopPropagation(); handleDownload(entry) }}>
                <Download size={12} />
              </button>
            )}
            {!isDir && (
              <button className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent" title="预览" onClick={(e) => { e.stopPropagation(); handlePreview(entry) }}>
                <Eye size={12} />
              </button>
            )}
            <button className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent hover:text-destructive" title="删除" onClick={(e) => { e.stopPropagation(); handleDelete(entry) }}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
        {/* 子节点 */}
        {isDir && isExpanded && children && children.length > 0 && (
          children.map((child) => <TreeRow key={child.path} entry={child} depth={depth + 1} />)
        )}
      </React.Fragment>
    )
  }, [expandedPaths, dragOverFolder, handlePreview, handleDownload, handleDelete, selectedPaths, toggleSelect, dragSourceInternal, handleMove, handleDropFiles])

  return (
    <>
      <div className="h-full flex gap-2 min-w-0"
      >
      {/* ===== 左侧：文件管理区 ===== */}
      <div className={cn(
        'relative flex flex-col flex-1 min-w-0 h-full bg-content-area rounded-2xl shadow-xl dark:shadow-sm overflow-hidden transition-all duration-200',
        dragOver && 'ring-2 ring-primary/40 shadow-primary/20 shadow-2xl',
      )}
        onDragEnter={handleContainerDragEnter}
        onDragOver={handleContainerDragEnter}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
          {/* 顶部栏 */}
          <div className="relative z-10 flex h-11 items-center gap-2 border-b border-border/50 bg-background px-3 flex-shrink-0">
            <div className={cn('pointer-events-none absolute inset-0 titlebar-drag-region', isWindows && 'right-[118px]')} />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <FolderOpen size={14} className="shrink-0 text-blue-500" />
              <span className="truncate text-sm font-semibold">{workspace?.name ?? '团队工作区'}</span>
            </div>
            {memberCount > 0 && (
              <span className="hidden shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground sm:flex">
                <Users size={12} />{memberCount}
                {onlineCount > 0 && (
                  <span className="ml-1 flex items-center gap-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    {onlineCount}
                  </span>
                )}
              </span>
            )}
            <div className="titlebar-no-drag flex shrink-0 items-center gap-1 overflow-visible whitespace-nowrap">
            {/* 排序 */}
            <div className="relative">
              <button className="h-8 min-w-8 px-2 rounded-md flex items-center justify-center gap-1 text-[11px] font-medium hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setSortMenuOpen(!sortMenuOpen)} title={`排序：${sortBy === 'name' ? '名称' : sortBy === 'date' ? '日期' : '大小'} ${sortAsc ? '↑' : '↓'}`}>
                <ArrowUpDown size={13} />
                <span className="hidden 2xl:inline">{sortBy === 'name' ? '名称' : sortBy === 'date' ? '日期' : '大小'}</span>
                <span className="text-[10px] leading-none">{sortAsc ? '↑' : '↓'}</span>
              </button>
              {sortMenuOpen && (
                <div className="absolute right-0 top-8 z-50 w-32 bg-popover border rounded-lg shadow-lg py-1" onClick={() => setSortMenuOpen(false)}>
                  {(['name', 'date', 'size'] as const).map((key) => (
                    <button key={key}
                      className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left"
                      onClick={() => {
                        if (sortBy === key) setSortAsc(!sortAsc)
                        else { setSortBy(key); setSortAsc(true) }
                      }}>
                      <span>{key === 'name' ? '按名称' : key === 'date' ? '按日期' : '按大小'}</span>
                      {sortBy === key && <ArrowUp size={11} className={cn('transition-transform', !sortAsc && 'rotate-180')} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* 搜索 */}
            <button
              className={cn('h-8 w-8 rounded-md flex items-center justify-center hover:bg-accent transition-colors', searchActive ? 'text-primary' : 'text-muted-foreground')}
              title="搜索"
              onClick={() => { setSearchActive(!searchActive); if (searchActive) { setSearchQuery('') }; setTimeout(() => searchInputRef.current?.focus(), 50) }}
            >
              <Search size={14} />
            </button>
            {searchActive && (
              <input
                ref={searchInputRef}
                type="text"
                className="h-8 w-28 lg:w-40 px-2 rounded-md border bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="搜索文件..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearchActive(false); setSearchQuery('') } }}
              />
            )}
            {/* 全选 */}
            {filteredEntries.length > 0 && (
              <button className="h-8 w-8 rounded-md flex items-center justify-center hover:bg-accent transition-colors"
                title={allSelected ? '取消全选' : '全选'}
                onClick={toggleSelectAll}
                style={{ color: allSelected ? 'var(--color-primary, #3b82f6)' : undefined }}>
                {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
              </button>
            )}
            {/* 刷新 */}
            <button className="h-8 w-8 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground" onClick={loadFiles} disabled={loading}>
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            </button>
            {/* 视图切换 */}
            <button className="h-8 w-8 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setViewMode(viewMode === 'grid' ? 'list' : 'grid') }}
              title={viewMode === 'grid' ? '文件夹视图' : '卡片视图'}>
              {viewMode === 'grid' ? <LayoutList size={14} /> : <LayoutGrid size={14} />}
            </button>
            {/* 失败重试 */}
            {failedUploads.length > 0 && (
              <button className="hidden h-8 items-center gap-1.5 rounded-md bg-red-50 px-2 text-[11px] text-red-600 transition-colors hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 xl:flex"
                onClick={retryFailed} title="点击重试上传失败的文件">
                <CloudOff size={13} />{failedUploads.length}个失败，点此重试
              </button>
            )}
            {/* 新建文件夹 */}
            {teamId && (
              <button className="h-8 w-8 rounded-md flex items-center justify-center text-xs font-medium hover:bg-accent border"
                onClick={() => { setShowNewFolder(true); setNewFolderName('') }} title="新建文件夹">
                <FolderPlus size={13} />
              </button>
            )}
            {/* 上传（下拉菜单：文件 / 文件夹） */}
            <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
              <div className="titlebar-no-drag inline-flex h-8 overflow-hidden rounded-md bg-primary text-primary-foreground shadow-sm">
                <button
                  type="button"
                  className="flex h-8 min-w-8 items-center justify-center gap-1 px-2 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50 2xl:px-3"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setUploadMenuOpen(false)
                    fileInputRef.current?.click()
                  }}
                  disabled={uploading}
                  title={uploading ? '上传中' : '上传文件'}
                >
                  <Upload size={13} />
                  <span className="hidden whitespace-nowrap 2xl:inline">{uploading ? '上传中' : '上传文件'}</span>
                </button>
                <button
                  type="button"
                  className="flex h-8 w-8 shrink-0 items-center justify-center border-l border-primary-foreground/30 transition-colors hover:bg-primary/90 disabled:opacity-50"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setUploadMenuOpen((open) => !open)
                  }}
                  disabled={uploading}
                  aria-haspopup="menu"
                  aria-expanded={uploadMenuOpen}
                  title="展开上传选项"
                >
                  <ChevronDown size={13} className={cn('transition-transform duration-150', uploadMenuOpen && 'rotate-180')} />
                </button>
              </div>
              {uploadMenuOpen && (
                <div className="titlebar-no-drag absolute right-0 top-[calc(100%+4px)] z-[80] w-36 rounded-lg border bg-popover py-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation()
                      setUploadMenuOpen(false)
                      requestAnimationFrame(() => fileInputRef.current?.click())
                    }}
                  >
                    <Upload size={13} />上传文件
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation()
                      setUploadMenuOpen(false)
                      handleUploadFolder()
                    }}
                  >
                    <FolderUp size={13} />上传文件夹
                  </button>
                </div>
              )}
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden"
              onChange={(e) => { if (e.target.files) handleUpload(e.target.files); e.target.value = '' }} />
            </div>
            <WindowControls variant="inline" className="titlebar-no-drag -mr-1 ml-1" />
          </div>

          {/* 拖拽提示 */}
          {dragOver && (
            <div className="absolute inset-0 z-50 bg-primary/5 flex items-center justify-center pointer-events-none backdrop-blur-[1px]">
              <div className="bg-background/95 rounded-2xl px-8 py-6 shadow-2xl border-2 border-dashed border-primary/60 text-center animate-pulse"
                style={{ animationDuration: '2s' }}>
                <div className="relative mx-auto mb-3 w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                  {dragSourceInternal
                    ? <FolderOpen size={28} className="text-primary animate-bounce" />
                    : <Upload size={28} className="text-primary animate-bounce" />
                  }
                </div>
                <p className="text-sm font-semibold mb-1">
                  {dragSourceInternal ? '释放以移动文件' : '释放文件以上传'}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {dragSourceInternal
                    ? `移动到 ${dragOverFolder ? `"${dragOverFolder.split('/').pop()}"` : '当前目录'}`
                    : (dragOverFolder ? `上传到 "${dragOverFolder.split('/').pop()}" 文件夹` : '上传到当前目录')
                  }
                </p>
              </div>
            </div>
          )}

          {/* 新建文件夹弹窗 */}
          {showNewFolder && (
            <div className="absolute top-12 right-4 z-50 bg-popover border rounded-xl shadow-xl p-4 w-64">
              <p className="text-sm font-medium mb-3">新建文件夹</p>
              <input
                autoFocus
                type="text"
                className="w-full h-9 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="输入文件夹名称"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false) }}
              />
              <div className="flex gap-2 mt-3 justify-end">
                <button className="h-8 px-3 rounded-md text-xs border hover:bg-accent" onClick={() => setShowNewFolder(false)}>取消</button>
                <button className="h-8 px-3 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={!newFolderName.trim()} onClick={handleCreateFolder}>创建</button>
              </div>
            </div>
          )}

          {/* 文件内容区 */}
          <ScrollArea className="flex-1 select-none">
            {loading ? (
              <div className="flex items-center justify-center h-40"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
            ) : empty ? (
              <div className="flex flex-col items-center justify-center h-60 gap-3 text-muted-foreground">
                <Cloud size={40} strokeWidth={1} />
                <p className="text-sm">拖拽文件或文件夹到此处上传</p>
                <div className="flex gap-2">
                  <button className="h-8 px-3 rounded-md border text-xs font-medium hover:bg-accent" onClick={() => fileInputRef.current?.click()}><Plus size={14} className="mr-1 inline" />上传文件</button>
                  <button className="h-8 px-3 rounded-md border text-xs font-medium hover:bg-accent" onClick={() => handleUploadFolder()}><FolderUp size={14} className="mr-1 inline" />上传文件夹</button>
                </div>
              </div>
            ) : viewMode === 'grid' ? (
              /* 卡片网格 */
              <div className="p-3">
                {/* 面包屑导航 */}
                {currentPath && (
                  <div className="flex items-center gap-1 mb-2 text-xs text-muted-foreground">
                    <button className="hover:text-foreground hover:underline flex items-center gap-0.5" onClick={() => setCurrentPath(null)}>
                      <FolderOpen size={13} />根目录
                    </button>
                    {currentPath.split('/').map((seg, i, arr) => {
                      const partial = arr.slice(0, i + 1).join('/')
                      const isLast = i === arr.length - 1
                      return (
                        <React.Fragment key={partial}>
                          <ChevronRight size={11} className="flex-shrink-0" />
                          {isLast ? (
                            <span className="text-foreground font-medium">{seg}</span>
                          ) : (
                            <button className="hover:text-foreground hover:underline" onClick={() => setCurrentPath(partial)}>
                              {seg}
                            </button>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </div>
                )}
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
                {sortItems(filteredEntries.filter((e) => isDirectChild(e.path, currentPath || ''))).map((entry) => (
                  <div key={entry.path}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-proma-move', entry.path)
                      e.dataTransfer.setData('application/x-proma-team-file', createTeamFileDragPayload(entry))
                      e.dataTransfer.effectAllowed = 'copyMove'
                      setDragSourceInternal(true)
                    }}
                    onDragEnd={() => setDragSourceInternal(false)}
                    onClick={() => { if (menuOpen !== entry.path) { entry.isDirectory ? setCurrentPath(entry.path) : handlePreview(entry) } }}
                    onDoubleClick={() => { if (entry.isDirectory) setCurrentPath(entry.path) }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                  if (entry.isDirectory) { e.dataTransfer.dropEffect = 'move'; setDragOverFolder(entry.path) }
                      else e.dataTransfer.dropEffect = 'none'
                    }}
                    onDragLeave={(e) => { e.stopPropagation(); setDragOverFolder(null) }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null }
                      setDragOver(false); setDragSourceInternal(false); setDragOverFolder(null)
                      if (!entry.isDirectory) return
                      const src = e.dataTransfer.getData('application/x-proma-move')
                      if (src && src !== entry.path) handleMove(src, entry.path)
                      else if (!src) handleDropFiles(e, entry.path)
                    }}
                    className={cn(
                      'group relative flex flex-col items-center gap-2 p-3.5 rounded-xl border cursor-pointer transition-all',
                      entry.isDirectory && 'bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800',
                      dragOverFolder === entry.path ? 'border-primary bg-primary/20 shadow-lg scale-[1.02] ring-2 ring-primary/30' : !entry.isDirectory && 'border-border/40',
                      'hover:bg-accent/30 hover:border-border hover:shadow-sm transition-all',
                    )}
                    style={{ aspectRatio: '3/4' }}
                  >
                    {/* 选择框 */}
                    <div className="absolute top-2 left-2 z-20" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                      <button
                        className={cn('h-5 w-5 rounded flex items-center justify-center transition-all',
                          selectedPaths.has(entry.path)
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-background/80 border border-border/60 hover:border-primary/50 opacity-0 group-hover:opacity-100',
                        )}
                        onClick={() => toggleSelect(entry.path)}>
                        {selectedPaths.has(entry.path) && <CheckSquare size={12} />}
                      </button>
                    </div>
                    {/* 三点菜单 */}
                    <div className="absolute top-2 right-2 z-20" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                      <button
                        className="h-6 w-6 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 bg-background/80 hover:bg-accent transition-opacity"
                        onClick={() => setMenuOpen(menuOpen === entry.path ? null : entry.path)}>
                        <MoreHorizontal size={13} />
                      </button>
                      {menuOpen === entry.path && (
                        <div className="absolute right-0 top-8 w-40 bg-popover border rounded-lg shadow-lg py-1 z-50" onClick={(e) => e.stopPropagation()}>
                          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left" onClick={() => { setMenuOpen(null); handlePreview(entry) }}>
                            <Eye size={13} />预览
                          </button>
                          {entry.syncStatus === 'cloud-only' && (
                            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left" onClick={() => { setMenuOpen(null); handleDownload(entry) }}>
                              <Download size={13} />下载到本地
                            </button>
                          )}
                          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left" onClick={async () => {
                            setMenuOpen(null)
                            if (!entry.isDirectory) {
                              const local = await handleDownload(entry)
                              if (local) window.electronAPI.showItemInFolder(local).catch(() => {})
                              return
                            }
                            if (filesPath) window.electronAPI.showItemInFolder(`${filesPath}/${entry.path}`).catch(() => {})
                          }}>
                            <FolderSearch size={13} />在文件夹查看
                          </button>
                          {!entry.isDirectory && (
                            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left" onClick={() => {
                              setMenuOpen(null)
                              void handleDownload(entry).then((local) => {
                                if (local) window.electronAPI.systemOpenFile(local).catch(() => {})
                              })
                            }}>
                              <ExternalLink size={13} />用应用打开
                            </button>
                          )}
                          {failedUploads.some((f) => f.name === entry.name) && (
                            <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left text-muted-foreground" onClick={() => {
                              setMenuOpen(null)
                              setFailedUploads((prev) => prev.filter((x) => x.name !== entry.name))
                            }}>
                              <Trash2 size={13} />移除
                            </button>
                          )}
                          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-destructive text-left" onClick={() => { setMenuOpen(null); handleDelete(entry) }}>
                            <Trash2 size={13} />删除
                          </button>
                        </div>
                      )}
                    </div>

                    {/* 图标 */}
                    <div className={cn('flex-1 flex items-center justify-center w-full pointer-events-none', entry.isDirectory && 'text-blue-500 dark:text-blue-400')}>
                      <FileTypeIcon name={entry.name} isDirectory={entry.isDirectory} size={40} />
                    </div>

                    {/* 文件名 */}
                    <span className="text-[11px] text-center leading-snug line-clamp-2 break-all w-full font-medium">
                      {entry.name}
                    </span>
                    {entry.isDirectory && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 font-medium">
                        {folderItemCounts.has(entry.path) ? `${folderItemCounts.get(entry.path)} 项` : '空文件夹'}
                      </span>
                    )}

                    {/* 底部信息 */}
                    <div className="flex items-center gap-1.5 w-full justify-center flex-wrap">
                      {failedUploads.some((f) => f.name === entry.name) ? (
                        <button className="flex items-center gap-1 text-[10px] text-red-500 hover:text-red-600" title="上传失败，点击重试"
                          onClick={(e) => { e.stopPropagation(); retrySingle(entry.name) }}>
                          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />重试
                        </button>
                      ) : (
                        <>
                          {entry.syncStatus === 'cloud-only' && (
                            <span className="text-amber-500" title="仅云端，点击下载"><Cloud size={11} /></span>
                          )}
                          {entry.syncStatus === 'local-only' && (
                            <span className="text-muted-foreground/40" title="仅本地"><CloudOff size={11} /></span>
                          )}
                          {entry.syncStatus === 'synced' && (
                            <span className="text-green-500" title="已同步到本地"><span className="text-[10px]">✓</span></span>
                          )}
                          {entry.syncStatus === 'conflict' && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
                        </>
                      )}
                      {entry.uploadedByName && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground truncate max-w-[72px]" title={entry.uploadedByName}>
                          {entry.uploadedByName}
                        </span>
                      )}
                      {!entry.isDirectory && entry.size != null && (
                        <span className="text-[10px] text-muted-foreground/50">{formatSize(entry.size)}</span>
                      )}
                    </div>
                  </div>
                ))}
                </div>
              </div>
            ) : (
              /* 列表视图 → 树状结构 */
              <div className="p-1">
                {/* 面包屑导航 */}
                {currentPath && (
                  <div className="flex items-center gap-1 px-2 py-1.5 mb-1 text-xs text-muted-foreground">
                    <button className="hover:text-foreground hover:underline flex items-center gap-0.5" onClick={() => setCurrentPath(null)}>
                      <FolderOpen size={13} />根目录
                    </button>
                    {currentPath.split('/').map((seg, i, arr) => {
                      const partial = arr.slice(0, i + 1).join('/')
                      const isLast = i === arr.length - 1
                      return (
                        <React.Fragment key={partial}>
                          <ChevronRight size={11} className="flex-shrink-0" />
                          {isLast ? (
                            <span className="text-foreground font-medium">{seg}</span>
                          ) : (
                            <button className="hover:text-foreground hover:underline" onClick={() => setCurrentPath(partial)}>
                              {seg}
                            </button>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </div>
                )}
                {/* 树状条目 */}
                {treeEntries.filter((e) => isDirectChild(e.path, currentPath || '')).map((entry) => {
                  // 去除路径前缀，让子目录展示相对路径
                  const displayEntry = currentPath ? { ...entry, name: entry.path.slice(currentPath.length + 1) } : entry
                  return <TreeRow key={entry.path} entry={displayEntry} depth={0} />
                })}
              </div>
            )}
          </ScrollArea>

          {/* 批量操作栏 */}
          {selectedCount > 0 && (
            <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-t border-border/50 bg-accent/30">
              <span className="text-xs font-medium">已选 {selectedCount} 项</span>
              <div className="flex-1" />
              <button
                className="h-8 px-3 rounded-md text-xs font-medium border hover:bg-accent flex items-center gap-1.5"
                onClick={batchDownload}
              >
                <Download size={13} />下载
              </button>
              <button
                className="h-8 px-3 rounded-md text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/20 flex items-center gap-1.5"
                onClick={batchDelete}
                disabled={batchDeleting}
              >
                <Trash2 size={13} />{batchDeleting ? '删除中...' : '删除'}
              </button>
            </div>
          )}
        </div>

        {/* ===== 右侧：AI 对话面板 ===== */}
        {agentPanelCollapsed ? (
          <div
            className={cn(
              'relative flex h-full w-11 flex-shrink-0 flex-col overflow-hidden rounded-2xl bg-content-area shadow-xl dark:shadow-sm',
              agentDropOver && 'ring-2 ring-primary/50',
            )}
            onDragOverCapture={handleAgentDragOver}
            onDropCapture={handleAgentDrop}
            onDragOver={handleAgentDragOver}
            onDragLeave={handleAgentDragLeave}
            onDrop={handleAgentDrop}
          >
            <button
              type="button"
              className="titlebar-no-drag flex min-h-0 w-full flex-1 flex-col items-center justify-start gap-2 px-1.5 py-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              title="展开 Agent"
              onClick={() => setAgentPanelCollapsed(false)}
            >
              <PanelRightOpen size={16} />
              <span className="mt-1 [writing-mode:vertical-rl] text-[11px] font-medium tracking-wide">Agent</span>
            </button>
          </div>
        ) : (
        <div
          className={cn(
            'relative flex flex-col w-[360px] flex-shrink-0 min-h-0 bg-content-area rounded-2xl shadow-xl dark:shadow-sm overflow-hidden transition-all duration-200',
            agentDropOver && 'ring-2 ring-primary/50',
          )}
          onDragOverCapture={handleAgentDragOver}
          onDropCapture={handleAgentDrop}
          onDragOver={handleAgentDragOver}
          onDragLeave={handleAgentDragLeave}
          onDrop={handleAgentDrop}
        >
          {agentDropOver && (
            <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-lg bg-background/95 px-3 py-2 text-xs font-medium text-primary shadow-lg">
                <MessageSquarePlus size={14} />
                拖入 Agent 解读
              </div>
            </div>
          )}
          <div className="titlebar-drag-region relative flex h-11 items-center gap-2 border-b border-border/50 bg-background px-3 flex-shrink-0">
            <div className="pointer-events-none absolute inset-0 titlebar-drag-region" />
            <span className="flex-1 text-xs font-medium text-muted-foreground truncate">
              {workspace ? `${workspace.name} · Agent` : 'AI 对话'}
            </span>
            <button
              type="button"
              className="titlebar-no-drag flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="收起 Agent"
              onClick={() => setAgentPanelCollapsed(true)}
            >
              <PanelRightClose size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0 flex flex-col titlebar-no-drag">
            {teamAgentTabId ? (
              <CompactModelSelectorCtx.Provider value={true}>
                <div className="flex-1 min-h-0"><TabContent tabId={teamAgentTabId} /></div>
              </CompactModelSelectorCtx.Provider>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground p-4">
                <MessageSquareIcon size={24} strokeWidth={1} />
                <p className="text-xs text-center">暂无 Agent 对话</p>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  onClick={async () => {
                    if (!teamId) return
                    try {
                      const session = await window.electronAPI.createAgentSession(undefined, undefined, teamId)
                      setAgentSessions((prev) => [session, ...prev])
                      showAgentSession(session.id)
                    } catch (err) {
                      toast.error('创建 Agent 对话失败')
                    }
                  }}
                >
                  <MessageSquarePlus size={13} />
                  新建 Agent 对话
                </button>
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      {/* 预览弹窗 */}
      <FilePreviewDialog open={!!preview} filePath={preview?.path ?? ''} fileName={preview?.name ?? ''}
        onClose={() => setPreview(null)} teamDownload={preview?.download} />
    </>
  )
}

function MessageSquareIcon({ size, strokeWidth }: { size: number; strokeWidth: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
