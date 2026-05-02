/**
 * DiffTabContent — 主区域 Diff Tab 的内容
 *
 * 顶部：文件路径 + Split/Unified 切换 + 复制按钮
 * 下方：diff2html 渲染的 diff 视图
 */

import * as React from 'react'
import { Copy, Check } from 'lucide-react'
import { useAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { agentDiffViewModeAtom } from '@/atoms/agent-atoms'
import { DiffView } from './DiffView'

interface DiffTabContentProps {
  filePath: string
  dirPath: string
  isUntracked?: boolean
}

export function DiffTabContent({ filePath, dirPath, isUntracked }: DiffTabContentProps): React.ReactElement {
  const [viewMode, setViewMode] = useAtom(agentDiffViewModeAtom)
  const [diffContent, setDiffContent] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function loadDiff() {
      try {
        if (isUntracked) {
          const content = await window.electronAPI.getUntrackedContent({ dirPath, filePath })
          if (!cancelled) {
            // 构造伪 diff：将全部行标为新增
            const lines = content.split('\n')
            const pseudoDiff = [
              `diff --git a/${filePath} b/${filePath}`,
              `new file mode 100644`,
              `--- /dev/null`,
              `+++ b/${filePath}`,
              `@@ -0,0 +1,${lines.length} @@`,
              ...lines.map((l: string) => `+${l}`),
            ].join('\n')
            setDiffContent(pseudoDiff)
          }
        } else {
          const diff = await window.electronAPI.getFileDiff({ dirPath, filePath })
          if (!cancelled) {
            setDiffContent(diff || '')
          }
        }
      } catch {
        if (!cancelled) setDiffContent('')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadDiff()
    return () => { cancelled = true }
  }, [filePath, dirPath, isUntracked])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(diffContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 复制失败静默处理
    }
  }, [diffContent])

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-[12px] text-foreground/60 truncate flex-1" title={filePath}>
          {filePath}
        </span>

        {/* Split / Unified 切换滑块 */}
        <div className="relative flex rounded-lg bg-muted p-0.5 shrink-0">
          <div
            className={cn(
              'absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-background shadow-sm transition-transform duration-200 ease-in-out',
              viewMode === 'unified' ? 'translate-x-full' : 'translate-x-0'
            )}
          />
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={cn(
              'relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              viewMode === 'split' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            分栏
          </button>
          <button
            type="button"
            onClick={() => setViewMode('unified')}
            className={cn(
              'relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              viewMode === 'unified' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            统一
          </button>
        </div>

        {/* 复制按钮 */}
        <button
          type="button"
          onClick={handleCopy}
          className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0"
          title="复制 diff 内容"
        >
          {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
        </button>
      </div>

      {/* Diff 内容 */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">
            加载中...
          </div>
        ) : (
          <DiffView diffContent={diffContent} viewMode={viewMode} />
        )}
      </div>
    </div>
  )
}
