/**
 * DiffChangesList — 代码改动文件列表
 *
 * 显示所有未暂存文件，按目录分组，支持 hover 操作按钮。
 */

import * as React from 'react'
import { ChevronRight, RotateCcw, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ChangedFileEntry, ChangeSource } from '@proma/shared'

/** 按目录分组后的数据结构 */
interface FileGroup {
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
  onFileClick: (filePath: string, isUntracked: boolean) => void
  /** 自动刷新信号（版本号递增触发） */
  refreshVersion?: number
  /** 当前选中的文件路径（高亮显示） */
  selectedFilePath?: string
}

/** 文件来源 badge 的颜色和文案 */
const SOURCE_CONFIG: Record<string, { color: string; label: string }> = {
  session: { color: 'bg-blue-500/10 text-blue-500', label: '会话' },
  workspace: { color: 'bg-purple-500/10 text-purple-500', label: '工作区' },
  both: { color: 'bg-cyan-500/10 text-cyan-500', label: '会话+工作区' },
  none: { color: 'bg-muted text-muted-foreground', label: '非工作区内' },
}

export function DiffChangesList({
  dirPath,
  sessionPath,
  workspaceFilesPath,
  onFileClick,
  refreshVersion,
  selectedFilePath,
}: DiffChangesListProps): React.ReactElement {
  const [files, setFiles] = React.useState<ChangedFileEntry[]>([])
  const [untrackedFiles, setUntrackedFiles] = React.useState<string[]>([])
  const [isGitRepo, setIsGitRepo] = React.useState(true)
  const [gitRootName, setGitRootName] = React.useState('')
  const [collapsedDirs, setCollapsedDirs] = React.useState<Set<string>>(new Set())

  const fetchChanges = React.useCallback(async () => {
    try {
      const result = await window.electronAPI.getUnstagedChanges(dirPath, sessionPath, workspaceFilesPath)
      setIsGitRepo(result.isGitRepo)
      setFiles(result.files || [])
      setUntrackedFiles(result.untrackedFiles || [])
      setGitRootName(result.gitRootName || '')
    } catch {
      setIsGitRepo(true) // 避免网络等错误误判
    }
  }, [dirPath, sessionPath, workspaceFilesPath])

  React.useEffect(() => {
    fetchChanges()
  }, [fetchChanges, refreshVersion])

  // 窗口重新聚焦时刷新（用户在外部编辑器改完代码切回 Proma）
  React.useEffect(() => {
    const onFocus = () => { fetchChanges() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchChanges])

  /** Revert 文件 */
  const handleRevert = React.useCallback(async (filePath: string) => {
    if (!window.confirm(`确定要还原 ${filePath} 的所有变更吗？此操作不可撤销。`)) return
    try {
      await window.electronAPI.revertFile({ dirPath, filePath })
      await fetchChanges()
    } catch {
      // Revert 失败静默处理
    }
  }, [dirPath, fetchChanges])

  /** Open in editor */
  const handleOpenInEditor = React.useCallback(async (filePath: string) => {
    try {
      const absolute = `${dirPath}/${filePath}`.replace(/\/+/g, '/')
      await window.electronAPI.openFile(absolute)
    } catch {
      // 打开失败静默处理
    }
  }, [dirPath])

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

  // 所有文件归到 gitRootName 一个组下
  const rootGroup = gitRootName || '/'
  const fileGroups: FileGroup[] = [{
    dirName: rootGroup,
    files,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
    sources: [...new Set(files.map((f) => f.source))],
  }]

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {fileGroups.map((group) => {
        const isCollapsed = collapsedDirs.has(group.dirName)
        return (
          <div key={group.dirName}>
            {/* 文件夹 bar */}
            <button
              type="button"
              onClick={() => toggleDir(group.dirName)}
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
              <span className="text-foreground/30 ml-auto shrink-0">
                {group.files.length} files  +{group.totalAdditions} -{group.totalDeletions}
              </span>
            </button>

            {/* 文件列表 */}
            {!isCollapsed && group.files.map((file) => (
              <FileRow
                key={file.filePath}
                file={file}
                isSelected={file.filePath === selectedFilePath}
                onClick={() => onFileClick(file.filePath, false)}
                onRevert={() => handleRevert(file.filePath)}
                onOpenInEditor={() => handleOpenInEditor(file.filePath)}
              />
            ))}
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
              onOpenInEditor={() => handleOpenInEditor(filePath)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 已追踪文件的行 */
function FileRow({
  file,
  onClick,
  onRevert,
  onOpenInEditor,
  isSelected,
}: {
  file: ChangedFileEntry
  onClick: () => void
  onRevert: () => void
  onOpenInEditor: () => void
  isSelected?: boolean
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false)

  return (
    <button
      type="button"
      className={cn(
        'flex items-center w-full px-2 pl-6 py-2.5 text-[14px] transition-colors group',
        isSelected ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]',
      )}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="truncate">
        {(() => {
          const parts = file.filePath.split('/')
          const fileName = parts.pop()!
          const dirPath = parts.join('/')
          return (
            <>
              {dirPath && (
                <span className="text-foreground/40">{dirPath}/</span>
              )}
              <span>{fileName}</span>
              {file.status === 'deleted' && (
                <span className="ml-1 text-foreground/30 text-[12px]">(已删除)</span>
              )}
            </>
          )
        })()}
      </span>

      {/* +/- 行数 */}
      <span className="ml-auto shrink-0 flex items-center gap-1.5">
        {file.additions > 0 && (
          <span className={isSelected ? 'text-green-500' : 'text-foreground/30'}>+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className={isSelected ? 'text-red-500' : 'text-foreground/30'}>-{file.deletions}</span>
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
                <RotateCcw className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">还原文件变更</TooltipContent>
          </Tooltip>
          {/* Open in editor 按钮 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="p-0.5 rounded hover:bg-foreground/[0.08] text-foreground/40 hover:text-foreground/70 cursor-pointer"
                onClick={onOpenInEditor}
              >
                <ExternalLink className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">在编辑器中打开</TooltipContent>
          </Tooltip>
        </span>
      )}
    </button>
  )
}

/** 未追踪文件的行 */
function UntrackedFileRow({
  filePath,
  onClick,
  onOpenInEditor,
}: {
  filePath: string
  onClick: () => void
  onOpenInEditor: () => void
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false)

  return (
    <button
      type="button"
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
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="p-0.5 rounded hover:bg-foreground/[0.08] text-foreground/40 hover:text-foreground/70 cursor-pointer"
                onClick={onOpenInEditor}
              >
                <ExternalLink className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">在编辑器中打开</TooltipContent>
          </Tooltip>
        </span>
      )}
    </button>
  )
}
