import * as React from 'react'
import { GitBranch, ChevronDown, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorktreeInfo } from '@proma/shared'

interface WorktreeSelectorProps {
  sessionId: string
  repoPath: string
  selectedPath: string | null
  onSelect: (worktree: WorktreeInfo | null) => void
}

export function WorktreeSelector({
  sessionId,
  repoPath,
  selectedPath,
  onSelect,
}: WorktreeSelectorProps): React.ReactElement {
  const [worktrees, setWorktrees] = React.useState<WorktreeInfo[]>([])
  const [isOpen, setIsOpen] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  const fetchWorktrees = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const list = await window.electronAPI.listWorktrees(repoPath, sessionId)
      setWorktrees(list.filter((wt) => !wt.isMain))
    } catch {
      setWorktrees([])
    } finally {
      setIsLoading(false)
    }
  }, [repoPath, sessionId])

  React.useEffect(() => {
    fetchWorktrees()
  }, [fetchWorktrees])

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const selectedWorktree = worktrees.find((wt) => wt.path === selectedPath)
  const displayLabel = selectedWorktree ? selectedWorktree.branch : '会话改动'

  if (worktrees.length === 0 && !isLoading) return <></>

  return (
    <div ref={dropdownRef} className="relative px-3 py-1.5 border-b border-border/50">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs',
            'hover:bg-accent/50 transition-colors',
            'text-muted-foreground hover:text-foreground',
            selectedWorktree && 'text-foreground font-medium',
          )}
        >
          <GitBranch className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[160px]">{displayLabel}</span>
          <ChevronDown className={cn('w-3 h-3 shrink-0 transition-transform', isOpen && 'rotate-180')} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            fetchWorktrees()
          }}
          className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          title="刷新 worktree 列表"
        >
          <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
        </button>
      </div>

      {isOpen && (
        <div className="absolute left-2 right-2 top-full mt-0.5 z-50 bg-popover border border-border rounded-md shadow-md py-1 max-h-[200px] overflow-y-auto">
          <button
            onClick={() => {
              onSelect(null)
              setIsOpen(false)
            }}
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors',
              !selectedPath && 'bg-accent/30 font-medium',
            )}
          >
            会话改动
          </button>
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              onClick={() => {
                onSelect(wt)
                setIsOpen(false)
              }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors flex items-center gap-2',
                selectedPath === wt.path && 'bg-accent/30 font-medium',
              )}
            >
              <GitBranch className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{wt.branch}</span>
              <span className="text-muted-foreground ml-auto shrink-0">{wt.head}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
