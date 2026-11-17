/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠]
 *
 * MainArea 支持多标签页，Settings 视图为独立覆盖。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { TabBar } from '@/components/tabs/TabBar'
import { WindowControlsTemplateProvider } from '@/components/WindowControlsTemplate'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSidePanelOpenAtom, agentSidePanelWidthAtom, currentAgentSessionIdAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom, agentDiffPanelTabAtom } from '@/atoms/agent-atoms'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { detectIsWindows } from '@profer/ui'
import { interfaceVariantAtom } from '@/atoms/theme'
import { usePanelAutoLayout } from '@/hooks/usePanelAutoLayout'
import { cn } from '@/lib/utils'

const MIN_RIGHT_PANEL_WIDTH = 300
const MAX_RIGHT_PANEL_WIDTH = 560

// 左侧栏拖拽范围按「列表宽」计算（外壳总宽 = 54 常驻 rail + 列表宽）。
// 下限 230 为原有列表宽度，下限以上可按需拖宽；上限 360 避免把主区挤成单栏。
const MIN_LEFT_SIDEBAR_WIDTH = 230
const MAX_LEFT_SIDEBAR_WIDTH = 360
// 拖动分隔条进入收起区后，先保留可逆滑出预览，松手再吸附或回弹。
const LEFT_SIDEBAR_COLLAPSED_WIDTH = 58
const LEFT_SIDEBAR_COLLAPSE_SNAP_PROGRESS = 0.5
const LEFT_SIDEBAR_COLLAPSE_SNAP_MS = 160
const LEFT_SIDEBAR_COLLAPSE_RELEASE_MS = 200
const LEFT_SIDEBAR_RAIL_WIDTH = 54

function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const filePanelVisible = useAtomValue(panelVisibilityAtom).filePanel
  const activeRightPanelTab = useAtomValue(agentDiffPanelTabAtom).get(currentSessionId ?? '') ?? 'session'
  const setSidePanelOpen = useSetAtom(agentSidePanelOpenAtom)

  // 聚焦右侧面板（profer:focus-right-panel 事件，来自快捷键/全局提示）
  React.useEffect(() => {
    const focusRightPanel = (): void => {
      setSidePanelOpen(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const panel = document.querySelector<HTMLElement>('[data-profer-navigation-region="right-panel"]')
          const target = panel && Array.from(panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )).find((element) => element.offsetParent !== null)
          target?.focus()
        })
      })
    }
    window.addEventListener('profer:focus-right-panel', focusRightPanel)
    return () => window.removeEventListener('profer:focus-right-panel', focusRightPanel)
  }, [setSidePanelOpen])

  const automationForm = useAtomValue(automationFormAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)
  // 定时任务表单打开时隐藏右侧文件面板，让中间区域扩展到全宽（表单内含自己的右栏配置）
  const activeView = useAtomValue(activeViewAtom)
  const showRightPanel = appMode === 'agent' && !!currentSessionId && !automationForm.open && activeView !== 'planning' && activeView !== 'agent-skills' && activeView !== 'agent-memory'
  // 文件面板/浏览器仅在 agent 个人视图参与布局判定（团队/规划/自动化表单时右侧面板不渲染）
  const filePanelActive = showRightPanel
  // 统一自适应可见性：窗口 resize 监听 + 浏览器/文件面板可见性计算（挂载于此布局容器）
  usePanelAutoLayout({ filePanelActive })
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  // 窗口标题设为用户名
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem('profer-user-profile')
      if (raw) {
        const profile = JSON.parse(raw)
        if (profile?.userName) {
          document.title = profile.userName
        }
      }
    } catch { /* ignore */ }
  }, [])

  // 右侧面板可拖拽宽度
  const [rightPanelWidth, setRightPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const dragging = React.useRef(false)
  const rightPanelMinimumWidth = MIN_RIGHT_PANEL_WIDTH
  const clampCurrentRightPanelWidth = React.useCallback(
    (width: number) => Math.max(rightPanelMinimumWidth, Math.min(MAX_RIGHT_PANEL_WIDTH, width)),
    [rightPanelMinimumWidth],
  )
  const clampedRightPanelWidth = clampCurrentRightPanelWidth(rightPanelWidth)

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    let rafId = 0

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = startX - ev.clientX
        const newWidth = clampCurrentRightPanelWidth(startWidth + delta)
        setRightPanelWidth(newWidth)
      })
    }

    const onMouseUp = () => {
      dragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampCurrentRightPanelWidth, clampedRightPanelWidth, setRightPanelWidth])

  // 左侧边栏可拖拽宽度
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const leftDragging = React.useRef(false)
  const leftDragReleaseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isDraggingLeftSidebar, setIsDraggingLeftSidebar] = React.useState(false)
  const [leftSidebarDragPreview, setLeftSidebarDragPreview] = React.useState<{
    width: number
    collapsed: boolean
    listWidthOverride?: number
    listTranslateX?: number
    transitionDurationMs?: number
  } | null>(null)
  const clampedLeftSidebarWidth = clampLeftSidebarWidth(leftSidebarWidth)

  React.useEffect(() => {
    if (clampedLeftSidebarWidth !== leftSidebarWidth) {
      setLeftSidebarWidth(clampedLeftSidebarWidth)
    }
  }, [clampedLeftSidebarWidth, leftSidebarWidth, setLeftSidebarWidth])

  React.useEffect(() => {
    return () => {
      if (leftDragReleaseTimer.current) {
        clearTimeout(leftDragReleaseTimer.current)
      }
    }
  }, [])

  const handleLeftSidebarMouseDown = React.useCallback((e: React.MouseEvent) => {
    if (leftDragReleaseTimer.current) return
    e.preventDefault()
    leftDragging.current = true
    setIsDraggingLeftSidebar(true)
    const startX = e.clientX
    const startCollapsed = sidebarCollapsed
    const startWidth = startCollapsed
      ? LEFT_SIDEBAR_COLLAPSED_WIDTH
      : LEFT_SIDEBAR_RAIL_WIDTH + clampedLeftSidebarWidth
    const minExpandedWidth = LEFT_SIDEBAR_RAIL_WIDTH + MIN_LEFT_SIDEBAR_WIDTH
    const maxExpandedWidth = LEFT_SIDEBAR_RAIL_WIDTH + MAX_LEFT_SIDEBAR_WIDTH
    let latestClientX = startX
    let wasSnapped = false
    let rafId = 0
    let onMouseMove: (ev: MouseEvent) => void
    let onMouseUp: () => void
    let onWindowBlur: () => void

    const setDragCursor = (active: boolean) => {
      document.body.style.userSelect = active ? 'none' : ''
      document.body.style.cursor = active ? 'col-resize' : ''
    }
    setDragCursor(true)

    const stopDragging = () => {
      leftDragging.current = false
      setIsDraggingLeftSidebar(false)
      setDragCursor(false)
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('blur', onWindowBlur)
    }

    const resolvePreviewWidth = (clientX: number): number => {
      const delta = clientX - startX
      return Math.max(
        LEFT_SIDEBAR_COLLAPSED_WIDTH,
        Math.min(maxExpandedWidth, startWidth + delta),
      )
    }

    const resolveListPreview = (previewWidth: number) => {
      if (previewWidth >= minExpandedWidth) {
        return {
          listWidthOverride: previewWidth - LEFT_SIDEBAR_RAIL_WIDTH,
          listTranslateX: 0,
        }
      }
      return {
        listWidthOverride: MIN_LEFT_SIDEBAR_WIDTH,
        // 保持列表宽度不变，继续向 rail 后方滑入；rail 的左边缘和位置不动。
        listTranslateX: previewWidth - minExpandedWidth,
      }
    }

    const applyPreview = () => {
      const pointerWidth = resolvePreviewWidth(latestClientX)
      let previewWidth = pointerWidth
      let collapsed = pointerWidth <= LEFT_SIDEBAR_COLLAPSED_WIDTH
      let snapped = false

      if (startCollapsed) {
        const progress = (pointerWidth - LEFT_SIDEBAR_COLLAPSED_WIDTH)
          / (minExpandedWidth - LEFT_SIDEBAR_COLLAPSED_WIDTH)
        snapped = progress >= LEFT_SIDEBAR_COLLAPSE_SNAP_PROGRESS
        if (snapped) {
          previewWidth = minExpandedWidth
          collapsed = false
        }
      } else if (pointerWidth < minExpandedWidth) {
        const progress = (minExpandedWidth - pointerWidth)
          / (minExpandedWidth - LEFT_SIDEBAR_COLLAPSED_WIDTH)
        snapped = progress >= LEFT_SIDEBAR_COLLAPSE_SNAP_PROGRESS
        if (snapped) {
          previewWidth = LEFT_SIDEBAR_COLLAPSED_WIDTH
          collapsed = true
        }
      }

      const listPreview = resolveListPreview(previewWidth)
      setLeftSidebarDragPreview({
        width: previewWidth,
        collapsed,
        ...listPreview,
        ...((snapped || wasSnapped) && {
          transitionDurationMs: LEFT_SIDEBAR_COLLAPSE_SNAP_MS,
        }),
      })
      wasSnapped = snapped
    }

    onMouseMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyPreview()
      })
    }

    onMouseUp = () => {
      if (!leftDragging.current) return
      const previewWidth = resolvePreviewWidth(latestClientX)
      stopDragging()

      if (startCollapsed) {
        const progress = (previewWidth - LEFT_SIDEBAR_COLLAPSED_WIDTH)
          / (minExpandedWidth - LEFT_SIDEBAR_COLLAPSED_WIDTH)
        if (progress >= LEFT_SIDEBAR_COLLAPSE_SNAP_PROGRESS) {
          setLeftSidebarDragPreview({
            width: minExpandedWidth,
            collapsed: false,
            ...resolveListPreview(minExpandedWidth),
            transitionDurationMs: LEFT_SIDEBAR_COLLAPSE_SNAP_MS,
          })
          leftDragReleaseTimer.current = setTimeout(() => {
            leftDragReleaseTimer.current = null
            setSidebarCollapsed(false)
            setLeftSidebarWidth(MIN_LEFT_SIDEBAR_WIDTH)
            setLeftSidebarDragPreview(null)
          }, LEFT_SIDEBAR_COLLAPSE_RELEASE_MS)
          return
        }

        setLeftSidebarDragPreview({
          width: LEFT_SIDEBAR_COLLAPSED_WIDTH,
          collapsed: true,
          ...resolveListPreview(LEFT_SIDEBAR_COLLAPSED_WIDTH),
          transitionDurationMs: LEFT_SIDEBAR_COLLAPSE_RELEASE_MS,
        })
        leftDragReleaseTimer.current = setTimeout(() => {
          leftDragReleaseTimer.current = null
          setLeftSidebarDragPreview(null)
        }, LEFT_SIDEBAR_COLLAPSE_RELEASE_MS)
        return
      }

      if (previewWidth >= minExpandedWidth) {
        setLeftSidebarWidth(previewWidth - LEFT_SIDEBAR_RAIL_WIDTH)
        setLeftSidebarDragPreview(null)
        return
      }

      const progress = (minExpandedWidth - previewWidth)
        / (minExpandedWidth - LEFT_SIDEBAR_COLLAPSED_WIDTH)
      const shouldCollapse = progress >= LEFT_SIDEBAR_COLLAPSE_SNAP_PROGRESS
      const targetWidth = shouldCollapse ? LEFT_SIDEBAR_COLLAPSED_WIDTH : startWidth
      setLeftSidebarDragPreview({
        width: targetWidth,
        collapsed: shouldCollapse,
        ...resolveListPreview(targetWidth),
        transitionDurationMs: shouldCollapse
          ? LEFT_SIDEBAR_COLLAPSE_SNAP_MS
          : LEFT_SIDEBAR_COLLAPSE_RELEASE_MS,
      })
      leftDragReleaseTimer.current = setTimeout(() => {
        leftDragReleaseTimer.current = null
        if (shouldCollapse) {
          setSidebarCollapsed(true)
        } else {
          setLeftSidebarWidth(startWidth - LEFT_SIDEBAR_RAIL_WIDTH)
        }
        setLeftSidebarDragPreview(null)
      }, LEFT_SIDEBAR_COLLAPSE_RELEASE_MS)
    }

    onWindowBlur = () => {
      if (!leftDragging.current) return
      stopDragging()
      setLeftSidebarDragPreview(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    window.addEventListener('blur', onWindowBlur)
  }, [clampedLeftSidebarWidth, setIsDraggingLeftSidebar, setLeftSidebarWidth, setSidebarCollapsed, sidebarCollapsed])

  const handleLeftSidebarKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Home') {
      e.preventDefault()
      setSidebarCollapsed(true)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setSidebarCollapsed(false)
      setLeftSidebarWidth(MAX_LEFT_SIDEBAR_WIDTH)
      return
    }

    const step = e.shiftKey ? 40 : 16
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

    e.preventDefault()
    if (sidebarCollapsed) {
      if (e.key === 'ArrowRight') {
        setSidebarCollapsed(false)
        setLeftSidebarWidth(MIN_LEFT_SIDEBAR_WIDTH)
      }
      return
    }
    const nextWidth = clampedLeftSidebarWidth + (e.key === 'ArrowRight' ? step : -step)
    if (nextWidth <= MIN_LEFT_SIDEBAR_WIDTH) {
      setSidebarCollapsed(true)
      return
    }
    setLeftSidebarWidth(clampLeftSidebarWidth(nextWidth))
  }, [clampedLeftSidebarWidth, setLeftSidebarWidth, setSidebarCollapsed, sidebarCollapsed])

  return (
    <WindowControlsTemplateProvider>
    <AppShellProvider value={contextValue}>
      {/* 只保留顶端 8px 的全局拖拽缝隙。
          过去这里覆盖 50px 高的固定 drag-region；它会和 TabBar 内的 no-drag
          控件重叠。Electron 的原生 app-region 命中并不总是遵循 CSS z-index，
          尤其当皮肤为 TabBar 创建 backdrop-filter 合成层时，Tab、工具按钮会被
          误判为窗口拖动区而不可点击。TabBar、侧栏和各独立视图已经各自提供
          局部 drag region，因此全局层不能覆盖任何实际交互区域。 */}
      <div
        className={cn(
          'titlebar-drag-region fixed top-0 left-0 h-2 z-50',
          isWindows ? 'right-[126px]' : 'right-0'
        )}
      />

      <div className="shell-bg h-screen w-screen flex overflow-clip bg-surface-shell">
        {/* 左侧边栏：可折叠，可拖拽调整宽度 */}
        <div
          className={cn(
            isClassic ? 'p-2 pr-0' : '',
            // 收起 rail 必须压过其右侧的分隔线；冷启动直接恢复收起状态时，
            // 分隔线处于更高层会裁掉 rail 最右侧，造成整列图标视觉上向左偏移。
            sidebarCollapsed ? 'relative z-[62] flex-none crt-sidebar' : 'relative z-[70] flex-none crt-sidebar',
          )}
        >
          <LeftSidebar
            width={clampedLeftSidebarWidth}
            widthOverride={leftSidebarDragPreview?.width}
            collapsedOverride={leftSidebarDragPreview?.collapsed}
            listWidthOverride={leftSidebarDragPreview?.listWidthOverride}
            listTranslateX={leftSidebarDragPreview?.listTranslateX}
            transitionDurationMs={leftSidebarDragPreview?.transitionDurationMs}
            noTransition={isDraggingLeftSidebar}
          />
          {/* 收起态也保留分隔条：从 rail 右边向右拖动可直接展开并调整到目标宽度。 */}
          <div
            className="titlebar-no-drag absolute left-full top-0 bottom-0 z-[80] w-1.5 translate-x-px cursor-col-resize pointer-events-auto"
            onMouseDown={handleLeftSidebarMouseDown}
            onKeyDown={handleLeftSidebarKeyDown}
            tabIndex={0}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧边栏宽度"
            aria-valuemin={MIN_LEFT_SIDEBAR_WIDTH}
            aria-valuemax={MAX_LEFT_SIDEBAR_WIDTH}
            aria-valuenow={clampedLeftSidebarWidth}
          />
        </div>

        {/* 中间容器 */}
        <div className="main-area-glass-host flex-1 min-w-0 p-2 relative z-[60]">
          <MainArea />
        </div>

        {showRightPanel && (
          <div
            data-profer-navigation-region="right-panel"
            className={cn(
              // 上下边距始终保留，避免收起瞬间面板从上下各扩展 8px；仅切换右侧
              // 横向 padding，并让 SidePanel 自身负责宽度过渡，保持收起方向纯水平。
              filePanelVisible
                ? 'relative z-[70] flex items-stretch crt-sidebar py-2 pr-2 pl-0'
                : 'relative z-[60] flex items-stretch crt-sidebar py-2 pr-0 pl-0'
            )}
          >
            <RightSidePanel width={clampedRightPanelWidth} />
            {/* 透明命中区收窄为 6px，仅落在现有中缝中心，不参与布局也不产生额外留白。 */}
            {filePanelVisible && (
              <div
                className="titlebar-no-drag absolute -left-[7px] top-0 bottom-0 z-[80] w-1.5 cursor-col-resize pointer-events-auto"
                onMouseDown={handleMouseDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="调整右侧文件面板宽度"
              />
            )}
          </div>
        )}
      </div>
    </AppShellProvider>
    </WindowControlsTemplateProvider>
  )
}
