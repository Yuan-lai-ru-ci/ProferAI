/**
 * PreviewTabContent — 会话绑定的文件预览 Tab 内容。
 *
 * 每文件一个 Tab：TabItem 自带 filePath，完整 PreviewFile 元数据存于
 * previewFilesByTabAtom（按 tabId 索引，打开时写入，关闭时清理）。
 * 内容统一由 DiffTabContent 渲染（长尾/静态图经其 OfvPreview 回退）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { FolderOpen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import {
  agentSessionPathMapAtom,
} from '@/atoms/agent-atoms'
import { getFileBaseName } from '@/atoms/tab-atoms'
import { previewFilesByTabAtom } from '@/atoms/preview-atoms'
import { IMAGE_PREVIEW_EXTS } from '@/lib/preview-extension-sets'
import { cn } from '@/lib/utils'
import { DefaultAppOpenButton } from './DefaultAppOpenButton'
import { DiffTabContent } from './DiffTabContent'
import { getDefaultAppTargetPath, getPreviewFileAccess, resolvePreviewDirPath } from './preview-open-path'

interface PreviewTabContentProps {
  /** 预览 Tab id（同时也是 previewFilesByTabAtom 的 key） */
  tabId: string
  sessionId: string
  filePath: string
}

export function PreviewTabContent({ tabId, sessionId, filePath }: PreviewTabContentProps): React.ReactElement {
  const filesByTab = useAtomValue(previewFilesByTabAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)

  const currentFile = filesByTab.get(tabId) ?? null
  const sessionPath = sessionPathMap.get(sessionId) ?? ''
  const fileName = getFileBaseName(filePath)

  if (!currentFile) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-content-area">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/30 px-3">
          <div className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
            {fileName}
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          预览状态已失效，请重新打开该文件
        </div>
      </div>
    )
  }

  const dirPath = currentFile.dirPath || sessionPath || resolvePreviewDirPath(currentFile.filePath, sessionPath)
  const defaultAppTargetPath = getDefaultAppTargetPath(currentFile, sessionPath)
  const defaultAppAccess = getPreviewFileAccess(sessionId, currentFile, sessionPath)
  // 图片预览不铺 bg-content-area 实色：透出底层壁纸，与会话区背景一致
  // （会话区是透明透壁纸的，实色面板背景会让图片预览区显得是另一块颜色）
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : ''
  const isImagePreview = IMAGE_PREVIEW_EXTS.has(ext)
  return (
    <div className={cn('flex h-full flex-col overflow-hidden', !isImagePreview && 'bg-content-area')}>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border/30 px-3 titlebar-no-drag">
        <span className="min-w-0 max-w-[30%] truncate text-xs font-medium text-muted-foreground" title={currentFile.filePath}>
          {fileName}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(currentFile.filePath)
              .then(() => toast.success('文件路径复制成功'))
              .catch(() => toast.error('文件路径复制失败'))
          }}
          className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground/65 hover:text-foreground hover:underline underline-offset-2"
          title={`${currentFile.filePath}（点击复制完整路径）`}
        >
          {currentFile.filePath}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <DefaultAppOpenButton
            filePath={defaultAppTargetPath}
            access={defaultAppAccess}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  window.electronAPI.showItemInFolder(
                    defaultAppTargetPath,
                    currentFile.basePaths,
                  ).catch((err) => console.error('[PreviewTabContent] 打开文件位置失败:', err))
                }}
                className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
                aria-label="打开文件所在位置"
              >
                <FolderOpen className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>在文件管理器中显示</p></TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DiffTabContent
          key={`${sessionId}:${currentFile.filePath}:${currentFile.previewRevision ?? ''}`}
          filePath={currentFile.filePath}
          dirPath={dirPath}
          sessionId={sessionId}
          gitRoot={currentFile.gitRoot}
          previewOnly={currentFile.previewOnly}
          readOnly={currentFile.readOnly}
          basePaths={currentFile.basePaths}
          baseRef={currentFile.baseRef}
          agentPreviewSession={currentFile.previewRequestId && currentFile.previewRevision ? { requestId: currentFile.previewRequestId, revision: currentFile.previewRevision } : undefined}
          hideToolbar
        />
      </div>
    </div>
  )
}
