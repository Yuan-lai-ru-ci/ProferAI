/**
 * DiffChangesList — 代码改动文件列表
 *
 * 显示所有未暂存文件，按目录分组，支持 hover 操作按钮。
 */

import * as React from 'react'
import { ChevronRight, Undo2, ExternalLink } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { agentDiffUnseenFilesAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import type { ChangedFileEntry, ChangeSource, EditorApp } from '@proma/shared'

/** 按目录分组后的数据结构 */
interface FileGroup {
  /** 完整 Git 仓库路径（用作 React key，避免同名目录冲突） */
  gitRoot: string
  /** 显示用的目录名（仓库的最后一段） */
  dirName: string
  files: ChangedFileEntry[]
  totalAdditions: number
  totalDeletions: number
  sources: ChangeSource[]
}

interface DiffChangesListProps {
  /** Git 仓库根目录 */
  dirPath: string
  /** 会话工作目录（用于 badge 计算） */
  sessionPath?: string
  /** 工作区共享文件目录（用于 badge 计算） */
  workspaceFilesPath?: string
  /** 点击文件回调 */
  onFileClick: (filePath: string, isUntracked: boolean, gitRoot?: string) => void
  /** 自动刷新信号（版本号递增触发） */
  refreshVersion?: number
  /** 当前选中的文件路径（高亮显示） */
  selectedFilePath?: string
  /** 额外的候选目录（附加目录等） */
  extraPaths?: string[]
}

/** 文件来源 badge 的颜色和文案 */
const SOURCE_CONFIG: Record<string, { color: string; label: string }> = {
  session: { color: 'bg-blue-500/10 text-blue-500', label: '会话' },
  workspace: { color: 'bg-purple-500/10 text-purple-500', label: '工作区' },
  both: { color: 'bg-cyan-500/10 text-cyan-500', label: '会话+工作区' },
  none: { color: 'bg-muted text-muted-foreground', label: '附加目录文件' },
}

export function DiffChangesList({
  dirPath,
  sessionPath,
  workspaceFilesPath,
  onFileClick,
  refreshVersion,
  selectedFilePath,
  extraPaths,
}: DiffChangesListProps): React.ReactElement {
  const [files, setFiles] = React.useState<ChangedFileEntry[]>([])
  const [untrackedFiles, setUntrackedFiles] = React.useState<string[]>([])
  const [isGitRepo, setIsGitRepo] = React.useState(true)
  const [collapsedDirs, setCollapsedDirs] = React.useState<Set<string>>(new Set())
  /** 单调递增的 fetch 序号，用于丢弃乱序到达的旧响应 */
  const fetchSeqRef = React.useRef(0)

  // Agent 本轮刚修改但尚未查看的文件
  const unseenFilesMap = useAtomValue(agentDiffUnseenFilesAtom)
  const setUnseenFilesMap = useSetAtom(agentDiffUnseenFilesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const unseenFiles = unseenFilesMap.get(currentSessionId ?? '') ?? new Set<string>()

  const markFileAsSeen = React.useCallback((filePath: string) => {
    if (!currentSessionId) return
    setUnseenFilesMap((prev) => {
      const s = prev.get(currentSessionId)
      if (!s?.has(filePath)) return prev
      const m = new Map(prev)
      const next = new Set(s)
      next.delete(filePath)
      m.set(currentSessionId, next)
      return m
    })
  }, [currentSessionId, setUnseenFilesMap])

  const fetchChanges = React.useCallback(async () => {
    if (!dirPath) return // sessionPath 为空时跳过，避免空字符串被过滤导致找不到仓库
    const requestId = ++fetchSeqRef.current
    try {
      const result = await window.electronAPI.getUnstagedChanges(dirPath, sessionPath, workspaceFilesPath, extraPaths)
      // 竞态保护：仅当本次请求是最新的才写入 state
      if (requestId !== fetchSeqRef.current) return
      setIsGitRepo(result.isGitRepo)
      setFiles(result.files || [])
      setUntrackedFiles(result.untrackedFiles || [])
    } catch {
      if (requestId !== fetchSeqRef.current) return
      setIsGitRepo(true) // 避免网络等错误误判
    }
  }, [dirPath, sessionPath, workspaceFilesPath, extraPaths])

  React.useEffect(() => {
    fetchChanges()
  }, [fetchChanges, refreshVersion])

  // 窗口聚焦刷新已统一在 useGlobalAgentListeners 中处理（递增 refreshVersion）

  /** Revert 文件 */
  const handleRevert = React.useCallback(async (filePath: string, gitRoot: string) => {
    if (!window.confirm(`确定要还原 ${filePath} 的所有变更吗？此操作不可撤销。`)) return
    try {
      await window.electronAPI.revertFile({ dirPath, filePath, gitRoot })
      await fetchChanges()
    } catch (err) {
      window.alert(`还原失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }, [dirPath, fetchChanges])

  /** 切换文件夹折叠 */
  const toggleDir = React.useCallback((dirName: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirName)) {
        next.delete(dirName)
      } else {
        next.add(dirName)
      }
      return next
    })
  }, [])

  // 按 Git 仓库分组（在所有 hooks 之后、条件返回之前调用）
  const fileGroups: FileGroup[] = React.useMemo(() => {
    // 用完整 gitRoot 做 key，避免同名目录冲突
    const groups = new Map<string, ChangedFileEntry[]>()
    for (const f of files) {
      const key = f.gitRoot || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(f)
    }
    return [...groups.entries()].map(([gitRoot, groupFiles]) => ({
      gitRoot,
      dirName: gitRoot ? gitRoot.split('/').pop() || gitRoot : '/',
      files: groupFiles,
      totalAdditions: groupFiles.reduce((sum, f) => sum + f.additions, 0),
      totalDeletions: groupFiles.reduce((sum, f) => sum + f.deletions, 0),
      sources: [...new Set(groupFiles.map((f) => f.source))],
    }))
  }, [files])

  // 非 Git 仓库
  if (!isGitRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-[12px] text-center">当前目录不是 Git 仓库</p>
      </div>
    )
  }

  // 空状态
  if (files.length === 0 && untrackedFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-[12px] text-center">没有代码改动</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {fileGroups.map((group) => {
        const isCollapsed = collapsedDirs.has(group.gitRoot)
        return (
          <div key={group.gitRoot}>
            {/* 文件夹 bar */}
            <button
              type="button"
              onClick={() => toggleDir(group.gitRoot)}
              className="flex items-center gap-1 w-full px-2 py-2 text-[13px] font-medium text-foreground/60 hover:bg-foreground/[0.04] transition-colors"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')}
              />
              <span className="truncate">{group.dirName}</span>
              {/* 文件夹层级的来源 badges */}
              {group.sources.map((src) => {
                const cfg = SOURCE_CONFIG[src] ?? SOURCE_CONFIG.none!
                return (
                  <span key={src} className={cn('rounded px-1 py-0.5 text-[12px] leading-none shrink-0', cfg.color)}>
                    {cfg.label}
                  </span>
                )
              })}
              <span className="ml-auto shrink-0 flex items-center gap-1.5">
                <span className="text-foreground/30">{group.files.length} files</span>
                {group.totalAdditions > 0 && <span className="text-green-500">+{group.totalAdditions}</span>}
                {group.totalDeletions > 0 && <span className="text-red-500">-{group.totalDeletions}</span>}
              </span>
            </button>

            {/* 文件列表 */}
            {!isCollapsed && group.files.map((file) => {
              const absPath = `${file.gitRoot || dirPath}/${file.filePath}`.replace(/\/+/g, '/')
              return (
              <FileRow
                key={`${file.gitRoot}:${file.filePath}`}
                file={file}
                isSelected={file.filePath === selectedFilePath}
                isUnseen={unseenFiles.has(absPath)}
                onClick={() => { markFileAsSeen(absPath); onFileClick(file.filePath, false, file.gitRoot) }}
                onRevert={() => handleRevert(file.filePath, file.gitRoot)}
                dirPath={dirPath}
              />
              )
            })}
          </div>
        )
      })}

      {/* 未追踪文件分组 */}
      {untrackedFiles.length > 0 && (
        <div>
          <div className="flex items-center px-2 py-2 text-[13px] font-medium text-muted-foreground border-t border-border/30">
            未追踪文件
          </div>
          {untrackedFiles.map((filePath) => (
            <UntrackedFileRow
              key={filePath}
              filePath={filePath}
              onClick={() => onFileClick(filePath, true)}
              dirPath={dirPath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 编辑器选择按钮（下拉菜单） */
function EditorPickerButton({
  filePath,
  gitRoot,
  dirPath,
}: {
  filePath: string
  gitRoot?: string
  dirPath: string
}): React.ReactElement {
  const [editors, setEditors] = React.useState<EditorApp[]>([])
  const [loaded, setLoaded] = React.useState(false)

  const onOpenChange = React.useCallback((open: boolean) => {
    if (open && !loaded) {
      window.electronAPI.scanEditors().then(setEditors).catch(() => setEditors([]))
      setLoaded(true)
    }
  }, [loaded])

  const handlePick = React.useCallback((editorName?: string) => {
    const base = gitRoot || dirPath
    const absolute = `${base}/${filePath}`.replace(/\/+/g, '/')
    window.electronAPI.systemOpenFile(absolute, editorName).catch(() => {})
    if (editorName) {
      try { localStorage.setItem('proma-last-editor', editorName) } catch {}
    }
  }, [dirPath, filePath, gitRoot])

  const lastEditor = React.useMemo(() => {
    try { return localStorage.getItem('proma-last-editor') } catch { return null }
  }, [])

  return (
    <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger className="p-0.5 rounded hover:bg-foreground/[0.08] text-foreground/40 hover:text-foreground/70 cursor-pointer">
          <ExternalLink className="size-4" />
        </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="min-w-[180px]">
        <DropdownMenuItem onClick={() => handlePick()}>系统默认</DropdownMenuItem>
        {editors.length > 0 && <DropdownMenuSeparator />}
        {/* 上次选择排在前面 */}
        {editors
          .filter((e) => e.name === lastEditor)
          .map((e) => (
            <DropdownMenuItem key={`last-${e.name}`} onClick={() => handlePick(e.name)}>
              {e.name}
            </DropdownMenuItem>
          ))}
        {editors
          .filter((e) => e.name !== lastEditor)
          .map((e) => (
            <DropdownMenuItem key={e.name} onClick={() => handlePick(e.name)}>
              {e.name}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
    </span>
  )
}

/** 已追踪文件的行 */
function FileRow({
  file,
  onClick,
  onRevert,
  isSelected,
  isUnseen,
  dirPath,
}: {
  file: ChangedFileEntry
  onClick: () => void
  onRevert: () => void
  isSelected?: boolean
  isUnseen?: boolean
  dirPath: string
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false)

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex items-center w-full px-2 pl-6 py-2.5 text-[14px] transition-colors group',
        isSelected
          ? 'session-item-selected bg-primary/10 shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
          : 'hover:bg-primary/5',
      )}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="truncate flex items-center gap-1">
        {(() => {
          const parts = file.filePath.split('/')
          const fileName = parts.pop()!
          const dir = parts.join('/')
          return (
            <>
              {dir && (
                <span className="text-foreground/40">{dir}/</span>
              )}
              <span>{fileName}</span>
              {file.status === 'deleted' && (
                <span className="ml-1 text-foreground/30 text-[12px]">(已删除)</span>
              )}
            </>
          )
        })()}
        {isUnseen && (
          <span className="size-1.5 rounded-full bg-primary shrink-0" />
        )}
      </span>

      {/* +/- 行数 */}
      <span className="ml-auto shrink-0 flex items-center gap-1.5">
        {file.additions > 0 && (
          <span className="!text-green-500">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="!text-red-500">-{file.deletions}</span>
        )}
      </span>

      {/* Hover 操作按钮 */}
      {hovered && (
        <span className="flex items-center gap-1 ml-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* Revert 按钮 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="p-0.5 rounded hover:bg-foreground/[0.08] text-foreground/40 hover:text-foreground/70 cursor-pointer"
                onClick={onRevert}
              >
                <Undo2 className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">还原文件变更</TooltipContent>
          </Tooltip>
          {/* 编辑器选择按钮 */}
          <EditorPickerButton filePath={file.filePath} gitRoot={file.gitRoot} dirPath={dirPath} />
        </span>
      )}
    </div>
  )
}

/** 未追踪文件的行 */
function UntrackedFileRow({
  filePath,
  onClick,
  dirPath,
}: {
  filePath: string
  onClick: () => void
  dirPath: string
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false)

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex items-center w-full px-2 pl-6 py-1.5 text-[14px] hover:bg-foreground/[0.04] transition-colors group"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="truncate">{filePath}</span>
      <span className="ml-1.5 rounded px-1 py-0.5 text-[12px] leading-none shrink-0 bg-amber-500/10 text-amber-500">
        新文件
      </span>

      {hovered && (
        <span className="ml-auto flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <EditorPickerButton filePath={filePath} dirPath={dirPath} />
        </span>
      )}
    </div>
  )
}
