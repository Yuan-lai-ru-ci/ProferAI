/**
 * DiffTabContent — 主区域 Diff Tab 的内容
 *
 * 顶部：文件路径 + 来源会话 + Split/Unified 切换 + 复制按钮
 * 下方：diff2html 渲染的 diff 视图
 */

import * as React from 'react'
import { Copy, Check, ArrowLeft } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentDiffViewModeAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { activeTabIdAtom, tabsAtom, type TabItem } from '@/atoms/tab-atoms'
import { DiffView } from './DiffView'

interface DiffTabContentProps {
  filePath: string
  dirPath: string
  sessionId?: string
  isUntracked?: boolean
}

export function DiffTabContent({ filePath, dirPath, sessionId, isUntracked }: DiffTabContentProps): React.ReactElement {
  const [viewMode, setViewMode] = useAtom(agentDiffViewModeAtom)
  const [diffContent, setDiffContent] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  // 来源会话信息
  const sessions = useAtomValue(agentSessionsAtom)
  const sessionTitle = sessionId ? sessions.find((s) => s.id === sessionId)?.title : null

  // 跳转到会话
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const handleGoToSession = React.useCallback(() => {
    if (!sessionId) return
    setTabs((prev) => {
      const existing = prev.find((t) => t.sessionId === sessionId && t.type === 'agent')
      if (existing) {
        setActiveTabId(existing.id)
        return prev
      }
      const newTab: TabItem = {
        id: sessionId,
        type: 'agent',
        sessionId,
        title: sessionTitle || sessionId,
      }
      setActiveTabId(sessionId)
      return [...prev, newTab]
    })
  }, [sessionId, sessionTitle, setTabs, setActiveTabId])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function loadDiff() {
      try {
        if (isUntracked) {
          const content = await window.electronAPI.getUntrackedContent({ dirPath, filePath })
          if (!cancelled) {
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
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border flex-shrink-0">
        <span className="text-[12px] text-foreground/60 truncate" title={filePath}>
          {filePath}
        </span>

        {/* Split / Unified 切换 — 整条点击切换 */}
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
          <span
            className={cn(
              'relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              viewMode === 'split' ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            分栏
          </span>
          <span
            className={cn(
              'relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              viewMode === 'unified' ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            统一
          </span>
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
      <div className="flex-1 overflow-auto relative">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">
            加载中...
          </div>
        ) : (
          <DiffView diffContent={diffContent} viewMode={viewMode} filePath={filePath} />
        )}

        {/* 返回对话按钮 */}
        {sessionId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="absolute bottom-32 left-1/2 -translate-x-1/2 p-3 rounded-full bg-content-area/90 border border-border shadow-md text-muted-foreground hover:text-foreground hover:bg-content-area transition-colors z-10"
                onClick={handleGoToSession}
              >
                <ArrowLeft className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">返回对话：{sessionTitle || sessionId}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
