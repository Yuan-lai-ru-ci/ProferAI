/**
 * DiffTabContent — 单文件 Diff 内容
 *
 * 加载文件新旧版本内容，通过 @pierre/diffs 渲染 diff。
 */

import * as React from 'react'
import { Copy, Check } from 'lucide-react'
import { useAtom, useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { agentDiffViewModeAtom, agentDiffRefreshVersionAtom } from '@/atoms/agent-atoms'
import { DiffView } from './DiffView'

interface DiffTabContentProps {
  filePath: string
  dirPath: string
  sessionId?: string
  isUntracked?: boolean
  gitRoot?: string
}

export function DiffTabContent({ filePath, dirPath, gitRoot }: DiffTabContentProps): React.ReactElement {
  const [viewMode, setViewMode] = useAtom(agentDiffViewModeAtom)
  const [oldContent, setOldContent] = React.useState('')
  const [newContent, setNewContent] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)
  const refreshVersion = useAtomValue(agentDiffRefreshVersionAtom)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function load() {
      try {
        const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot })
        if (!cancelled && result) {
          setOldContent(result.oldContent)
          setNewContent(result.newContent)
        }
      } catch {
        // 加载失败静默处理
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [filePath, dirPath, gitRoot, refreshVersion])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(newContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 复制失败
    }
  }, [newContent])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0">
        <span className="text-[12px] text-foreground/60 truncate" title={filePath}>
          {filePath}
        </span>

        {/* Split / Unified 切换 */}
        <div
          className="relative flex rounded-lg bg-muted p-0.5 shrink-0 ml-auto cursor-pointer select-none"
          onClick={() => setViewMode((v) => v === 'split' ? 'unified' : 'split')}
        >
          <div
            className={cn(
              'absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-background shadow-sm transition-transform duration-200 ease-in-out',
              viewMode === 'unified' ? 'translate-x-full' : 'translate-x-0',
            )}
          />
          <span className={cn('relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
            viewMode === 'split' ? 'text-foreground' : 'text-muted-foreground')}>分栏</span>
          <span className={cn('relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
            viewMode === 'unified' ? 'text-foreground' : 'text-muted-foreground')}>统一</span>
        </div>

        <button type="button" onClick={handleCopy}
          className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0"
          title="复制文件内容">
          {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
        </button>
      </div>

      <div className="flex-1 overflow-auto relative">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">加载中...</div>
        ) : (
          <DiffView oldContent={oldContent} newContent={newContent} filePath={filePath} viewMode={viewMode} />
        )}
      </div>
    </div>
  )
}
