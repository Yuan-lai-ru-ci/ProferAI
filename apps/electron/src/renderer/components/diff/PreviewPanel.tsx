/**
 * PreviewPanel — 内联预览/Diff 面板
 *
 * 嵌入 AgentView 右侧，始终显示当前选中文件的 diff。
 * Agent 修改文件时自动切换到最新修改的文件。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Maximize2, PanelRight, FolderOpen, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  previewPanelOpenMapAtom,
  previewFileMapAtom,
  previewModePreferenceAtom,
  updatePreviewModePreference,
} from '@/atoms/preview-atoms'
import { agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import {
  activeTabIdAtom,
  getPreviewTabTitle,
  openTab,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import { detectIsWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { getFileBaseName } from '@/lib/file-utils'
import { DiffTabContent } from './DiffTabContent'
import { DefaultAppOpenButton } from './DefaultAppOpenButton'
import { getDefaultAppTargetPath, getPreviewFileAccess } from './preview-open-path'
import { WindowControlsHost } from '@/components/WindowControlsTemplate'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { toast } from 'sonner'

interface PreviewPanelProps {
  sessionId: string
}

const WINDOWS_WINDOW_CONTROLS_SAFE_AREA = 126

export function PreviewPanel({ sessionId }: PreviewPanelProps): React.ReactElement {
  const fileMap = useAtomValue(previewFileMapAtom)
  const setOpenMap = useSetAtom(previewPanelOpenMapAtom)
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const filePanelVisible = useAtomValue(panelVisibilityAtom).filePanel
  const [previewModePref, setPreviewModePref] = useAtom(previewModePreferenceAtom)
  const currentFile = fileMap.get(sessionId) ?? null

  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const sessionPath = sessionPathMap.get(sessionId) ?? ''
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const useStackedWindowsHeader = isWindows && !filePanelVisible

  const fileName = currentFile ? getFileBaseName(currentFile.filePath) : '文件预览'
  const defaultAppTargetPath = currentFile ? getDefaultAppTargetPath(currentFile, sessionPath) : ''
  const defaultAppAccess = currentFile ? getPreviewFileAccess(sessionId, currentFile, sessionPath) : undefined

  const handleClosePanel = React.useCallback(() => {
    setOpenMap((prev) => { const m = new Map(prev); m.set(sessionId, false); return m })
  }, [sessionId, setOpenMap])

  const handleOpenPreviewTab = React.useCallback(() => {
    if (!currentFile) return
    const result = openTab(tabs, {
      type: 'preview',
      sessionId,
      title: getPreviewTabTitle(currentFile.filePath),
    })
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    setOpenMap((prev) => {
      const m = new Map(prev)
      m.set(sessionId, false)
      return m
    })
  }, [currentFile, sessionId, setActiveTabId, setOpenMap, setTabs, tabs])

  const handleShowInFolder = React.useCallback(() => {
    if (!defaultAppTargetPath) return
    window.electronAPI.showItemInFolder(
      defaultAppTargetPath,
      currentFile?.basePaths,
    ).catch((err) => console.error('[PreviewPanel] 打开文件位置失败:', err))
  }, [defaultAppTargetPath, currentFile?.basePaths])

  const renderPreviewActions = (): React.ReactElement => (
    <div className="ml-auto flex items-center gap-0.5 shrink-0">
      {currentFile && (
        <DefaultAppOpenButton
          filePath={defaultAppTargetPath}
          access={defaultAppAccess}
        />
      )}
      {currentFile && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleShowInFolder}
              className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
              aria-label="打开文件所在位置"
            >
              <FolderOpen className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>在文件管理器中显示</p>
          </TooltipContent>
        </Tooltip>
      )}
      {currentFile && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                const next = previewModePref === 'split' ? 'tab' : 'split'
                setPreviewModePref(next)
                void updatePreviewModePreference(next)
              }}
              className={cn(
                'flex items-center justify-center size-6 shrink-0 rounded transition-colors',
                previewModePref === 'split'
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              )}
              aria-label={previewModePref === 'split' ? '默认展开方式：侧边分屏，点击改为标签页' : '默认展开方式：标签页，点击改为侧边分屏'}
            >
              <PanelRight className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>
              {previewModePref === 'split'
                ? '默认展开方式：侧边分屏 · 点击改为「标签页」（仅影响下次打开，不改变当前预览）'
                : '默认展开方式：标签页 · 点击改为「侧边分屏」（仅影响下次打开，不改变当前预览）'}
            </p>
          </TooltipContent>
        </Tooltip>
      )}
      {currentFile && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenPreviewTab}
              className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
              aria-label="作为标签页打开预览"
            >
              <Maximize2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>作为标签页打开预览</p>
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClosePanel}
            className="flex items-center justify-center size-6 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded transition-colors"
            aria-label="关闭预览面板"
          >
            <X className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>关闭预览面板 ({getAcceleratorDisplay(getActiveAccelerator('toggle-preview-panel'))})</p>
        </TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <div className="relative flex flex-col h-full overflow-hidden bg-surface-raised titlebar-no-drag">
      {/* 预览在无右侧文件栏时延伸到窗口右缘，必须自行接管控制按钮。
          否则 TabBar 宿主仍会把按钮留在左侧会话区，与预览标题栏脱节。 */}
      <WindowControlsHost
        id="preview-panel"
        active={isWindows && !filePanelVisible}
        priority={20}
        className="absolute right-2 top-[3px] z-10"
      />
      {/* 顶部栏：上行只显示文件名，下行显示路径和预览操作。 */}
      <div className={cn('flex-shrink-0 border-b border-surface-border/30 titlebar-no-drag', useStackedWindowsHeader && 'bg-surface-raised')}>
        <div
          className="flex items-center h-[34px] px-3"
          style={useStackedWindowsHeader ? { paddingRight: WINDOWS_WINDOW_CONTROLS_SAFE_AREA } : undefined}
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={currentFile?.filePath}>
            {fileName}
          </span>
        </div>
        <div className="flex items-center h-[30px] gap-2 px-3 border-t border-surface-border/20 bg-surface-sunken/40">
          {currentFile && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(currentFile.filePath).then(() => toast.success('文件路径复制成功')).catch(() => toast.error('文件路径复制失败'))}
              className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground/65 hover:text-foreground hover:underline underline-offset-2"
              title={`${currentFile.filePath}（点击复制完整路径）`}
            >
              {currentFile.filePath}
            </button>
          )}
          {renderPreviewActions()}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {currentFile ? (
          <DiffTabContent
            key={`${sessionId}:${currentFile.filePath}`}
            filePath={currentFile.filePath}
            dirPath={currentFile.dirPath || sessionPath}
            sessionId={sessionId}
            gitRoot={currentFile.gitRoot}
            previewOnly={currentFile.previewOnly}
            readOnly={currentFile.readOnly}
            basePaths={currentFile.basePaths}
            baseRef={currentFile.baseRef}
            hideToolbar
            onEmptyDiff={handleClosePanel}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            点击文件查看预览
          </div>
        )}
      </div>
    </div>
  )
}
